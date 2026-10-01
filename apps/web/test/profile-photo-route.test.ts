import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  session: null as { user: { id: string } } | null,
  puts: [] as string[],
  deletes: [] as string[],
  putHook: null as null | (() => Promise<void>),
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => h.session } }),
}));
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) {
        h.puts.push(command.input.Key);
        await h.putHook?.();
      } else h.deletes.push(command.input.Key);
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});
const { POST, DELETE } = await import("@/app/api/profile-photo/route");
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db: h.db, close } = await createTestDb());
  h.session = { user: { id: "u1" } };
  h.puts = [];
  h.deletes = [];
  h.putHook = null;
  await h.db.insert(schema.user).values([
    { id: "u1", name: "User One", email: "u1@example.invalid" },
    {
      id: "u2",
      name: "User Two",
      email: "u2@example.invalid",
      image: "https://cdn.example.com/profile-photos/u2/existing.png",
    },
  ]);
  for (const [name, value] of Object.entries({
    APP_BASE_URL: "https://mepmail.dev",
    S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    S3_STORAGE_BUCKET: "avatars",
    S3_ACCESS_KEY_ID: "fixture",
    S3_SECRET_ACCESS_KEY: "fixture",
    S3_STORAGE_PUBLIC_URL: "https://cdn.example.com",
  }))
    vi.stubEnv(name, value);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});
function upload(bytes: Uint8Array<ArrayBuffer> = PNG, origin = "https://mepmail.dev") {
  const body = new FormData();
  body.set("file", new File([bytes], "photo.png", { type: "image/png" }));
  body.set("userId", "u2");
  return new Request("https://mepmail.dev/api/profile-photo", {
    method: "POST",
    body,
    headers: { origin },
  });
}
async function image(id = "u1") {
  return (
    await h.db.select({ image: schema.user.image }).from(schema.user).where(eq(schema.user.id, id))
  )[0]?.image;
}
describe("profile photo ownership and upload", () => {
  it("stores only the session user's image and ignores submitted userId", async () => {
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(await image()).toMatch(/^https:\/\/cdn\.example\.com\/profile-photos\/u1\//);
    expect(await image("u2")).toBe("https://cdn.example.com/profile-photos/u2/existing.png");
    expect(h.puts).toHaveLength(1);
  });
  it("requires a session even when an API key is supplied", async () => {
    h.session = null;
    const request = upload();
    request.headers.set("authorization", "Bearer ms_fixture");
    expect((await POST(request)).status).toBe(401);
    expect(h.puts).toHaveLength(0);
  });
  it("rejects another origin before upload or persistence", async () => {
    expect((await POST(upload(PNG, "https://attacker.example"))).status).toBe(403);
    expect(h.puts).toHaveLength(0);
    expect(await image()).toBeNull();
  });
  it("rejects forged PNG content including SVG", async () => {
    expect((await POST(upload(new TextEncoder().encode('<svg onload="alert(1)"/>')))).status).toBe(
      415,
    );
    expect(h.puts).toHaveLength(0);
  });
  it("caps a streaming body without relying on Content-Length", async () => {
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://mepmail.dev/api/profile-photo", {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        origin: "https://mepmail.dev",
        "content-type": "multipart/form-data; boundary=fixture",
      },
    } as RequestInit & { duplex: "half" });
    expect((await POST(request)).status).toBe(413);
    expect(canceled).toBe(true);
    expect(h.puts).toHaveLength(0);
  });
  it("replaces the object and removes only the caller's previous photo", async () => {
    await POST(upload());
    const first = h.puts[0];
    await POST(upload());
    expect(h.puts).toHaveLength(2);
    expect(h.puts[1]).not.toBe(first);
    expect(h.deletes).toEqual([first]);
  });
  it("cleans a concurrent upload loser instead of leaving a public orphan", async () => {
    await POST(upload());
    const previous = h.puts[0];
    h.puts = [];
    h.deletes = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.putHook = async () => {
      if (h.puts.length === 2) release();
      await gate;
    };
    const results = await Promise.all([POST(upload()), POST(upload())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = (await image())?.replace("https://cdn.example.com/", "");
    expect(h.deletes.sort()).toEqual([previous, ...h.puts.filter((key) => key !== current)].sort());
    expect(h.deletes).not.toContain(current);
  });
  it("cleans an in-flight upload when removal changed its previous image", async () => {
    await POST(upload());
    const previous = h.puts[0];
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored = new Promise<void>((resolve) => {
      ready = resolve;
    });
    h.putHook = async () => {
      ready();
      await gate;
    };
    const pending = POST(upload());
    await stored;
    const removed = await DELETE(
      new Request("https://mepmail.dev/api/profile-photo", { method: "DELETE" }),
    );
    release();
    expect(removed.status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(await image()).toBeNull();
    expect(h.deletes.sort()).toEqual([previous, h.puts[1]].sort());
  });
  it("does not remove another user's object even if it was set as the image", async () => {
    await h.db
      .update(schema.user)
      .set({ image: "https://cdn.example.com/profile-photos/u2/existing.png" })
      .where(eq(schema.user.id, "u1"));
    const response = await DELETE(
      new Request("https://mepmail.dev/api/profile-photo?userId=u2", {
        method: "DELETE",
        headers: { origin: "https://mepmail.dev" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await image()).toBeNull();
    expect(h.deletes).toHaveLength(0);
    expect(await image("u2")).not.toBeNull();
  });
  it("clears a provider photo without calling storage", async () => {
    await h.db
      .update(schema.user)
      .set({ image: "https://provider.example/avatar.jpg" })
      .where(eq(schema.user.id, "u1"));
    expect(
      (await DELETE(new Request("https://mepmail.dev/api/profile-photo", { method: "DELETE" })))
        .status,
    ).toBe(200);
    expect(await image()).toBeNull();
    expect(h.deletes).toHaveLength(0);
  });
  it("keeps uploads unavailable when storage is not configured", async () => {
    vi.stubEnv("S3_STORAGE_BUCKET", "");
    expect((await POST(upload())).status).toBe(404);
    expect(h.puts).toHaveLength(0);
  });
});
