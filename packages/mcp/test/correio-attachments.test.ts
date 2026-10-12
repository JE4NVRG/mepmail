import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCorreioTools } from "../src/correio.js";
import {
  attachmentFilename,
  cleanFilename,
  MAX_ATTACHMENT_BYTES,
  planDraftAttachments,
} from "../src/correio-attachments.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;
let base: string, uploads: string, downloads: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "mcp-att-"));
  uploads = join(base, "uploads");
  downloads = join(base, "downloads");
  await import("node:fs/promises").then((fs) =>
    Promise.all([fs.mkdir(uploads), fs.mkdir(downloads)]),
  );
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const data = (result: { content: { text: string }[] }) =>
  (JSON.parse(result.content[0]!.text) as { untrusted_data: Record<string, unknown> })
    .untrusted_data;

function setup(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  dirs: { downloadDir?: string; uploadDir?: string } = {},
) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => tools.set(name, cb),
  } as unknown as McpServer;
  const calls: { url: string; init: RequestInit }[] = [];
  registerCorreioTools(server, {
    token: "mmt_00000000-0000-4000-8000-000000000000.abc",
    origin: "https://mepmail.dev",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer(url, init);
    }) as typeof fetch,
    ...dirs,
  });
  return { tools, calls };
}
function file(bytes: Uint8Array, name = "relatório final.pdf") {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-mepmail-attachment-sha256": sha(bytes),
    },
  });
}

describe("attachment limits and sources", () => {
  it("checks size, count and total before any request, with a reason", async () => {
    const big = randomBytes(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    await expect(
      planDraftAttachments({
        keep: [],
        source: [],
        attachments: [{ filename: "a.bin", content_base64: big }],
      }),
    ).rejects.toThrow(/at most 256 KiB/);
    const small = randomBytes(10).toString("base64");
    await expect(
      planDraftAttachments({
        keep: [],
        source: [],
        attachments: Array.from({ length: 11 }, (_, i) => ({
          filename: `${i}.txt`,
          content_base64: small,
        })),
      }),
    ).rejects.toThrow(/at most 10 attachments/);
    const chunk = randomBytes(250 * 1024).toString("base64");
    await expect(
      planDraftAttachments({
        keep: [],
        source: [],
        attachments: [1, 2, 3].map((i) => ({ filename: `${i}.bin`, content_base64: chunk })),
      }),
    ).rejects.toThrow(/700 KiB/);
    await expect(
      planDraftAttachments({
        keep: [],
        source: [],
        attachments: [{ filename: "x", content_base64: "%%%" }],
      }),
    ).rejects.toThrow(/not valid base64/);
    await expect(
      planDraftAttachments({
        keep: [3],
        source: [{ index: 0, filename: "a", bytes: 1 }],
        attachments: [],
      }),
    ).rejects.toThrow(/no attachment 3/);
    await expect(
      planDraftAttachments({
        keep: [0],
        source: [{ index: 0, filename: "video.mp4", bytes: 3_000_000 }],
        attachments: [],
      }),
    ).rejects.toThrow(/video\.mp4.*Leave it out/);
  });

  it("reads local files only inside the upload folder", async () => {
    const inside = randomBytes(1000);
    await writeFile(join(uploads, "nota.pdf"), inside);
    await writeFile(join(base, "secret.txt"), "do not attach");
    const planned = await planDraftAttachments({
      keep: [],
      source: [],
      attachments: [{ path: "nota.pdf" }],
      uploadDir: uploads,
    });
    expect(planned.uploads).toEqual([{ filename: "nota.pdf", base64: inside.toString("base64") }]);
    for (const path of ["../secret.txt", join(base, "secret.txt")])
      await expect(
        planDraftAttachments({ keep: [], source: [], attachments: [{ path }], uploadDir: uploads }),
      ).rejects.toThrow(/Only files inside MEPMAIL_MAIL_UPLOAD_DIR/);
    // Without an upload folder, no local path is read at all.
    await expect(
      planDraftAttachments({ keep: [], source: [], attachments: [{ path: "nota.pdf" }] }),
    ).rejects.toThrow(/Reading local files is off/);
  });

  it("keeps file names safe", () => {
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("C:\\Users\\x\\a<b>.txt")).toBe("a_b_.txt");
    expect(cleanFilename("..")).toBe("attachment");
    expect(
      attachmentFilename(`attachment; filename*=UTF-8''${encodeURIComponent("ação.pdf")}`),
    ).toBe("ação.pdf");
  });
});

describe("mailbox_get_attachment", () => {
  it("returns small files inline with their digest, and refuses large ones without a folder", async () => {
    const bytes = randomBytes(2048);
    const { tools, calls } = setup(() => file(bytes));
    const result = data(
      await tools.get("mailbox_get_attachment")!({
        id: "11111111-1111-4111-8111-111111111111",
        revision: 3,
        index: 1,
      }),
    );
    expect(calls[0]!.url).toBe(
      "https://mepmail.dev/api/mailbox-agent/attachments?id=11111111-1111-4111-8111-111111111111&revision=3&index=1",
    );
    expect(result).toMatchObject({
      filename: "relatório final.pdf",
      bytes: 2048,
      sha256: sha(bytes),
    });
    expect(Buffer.from(result.content_base64 as string, "base64").equals(bytes)).toBe(true);
    const large = randomBytes(600 * 1024);
    const big = setup(() => file(large));
    const refused = await big.tools.get("mailbox_get_attachment")!({
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      index: 0,
    });
    expect(refused.isError).toBe(true);
    expect(data(refused)).toMatchObject({ error: "too_large_inline", sha256: sha(large) });
  });

  it("saves into the download folder without overwriting, and checks the server digest", async () => {
    const bytes = randomBytes(700 * 1024);
    const { tools } = setup(() => file(bytes, "fatura.pdf"), { downloadDir: downloads });
    const first = data(
      await tools.get("mailbox_get_attachment")!({
        id: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        index: 0,
      }),
    );
    const second = data(
      await tools.get("mailbox_get_attachment")!({
        id: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        index: 0,
      }),
    );
    expect((await readdir(downloads)).sort()).toEqual(["fatura (1).pdf", "fatura.pdf"]);
    expect(first).not.toHaveProperty("content_base64");
    expect(sha(await readFile(first.saved_to as string))).toBe(sha(bytes));
    expect(second.saved_to).not.toBe(first.saved_to);
    const tampered = setup(
      () =>
        new Response(randomBytes(10), {
          headers: {
            "content-disposition": "attachment",
            "x-mepmail-attachment-sha256": "0".repeat(64),
          },
        }),
    );
    expect(
      data(
        await tampered.tools.get("mailbox_get_attachment")!({
          id: "11111111-1111-4111-8111-111111111111",
          revision: 1,
          index: 0,
        }),
      ),
    ).toMatchObject({
      error: "corrupted",
    });
    const changed = setup(() => json({ error: "conflict" }, 409));
    expect(
      data(
        await changed.tools.get("mailbox_get_attachment")!({
          id: "11111111-1111-4111-8111-111111111111",
          revision: 1,
          index: 0,
        }),
      ),
    ).toMatchObject({
      status: 409,
      hint: expect.stringMatching(/read it again/),
    });
  });
});

describe("mailbox_save_draft with attachments", () => {
  const source = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 4,
    attachments: [
      { index: 0, filename: "a.pdf", bytes: 1000, image: null },
      { index: 1, filename: "b.png", bytes: 2000, image: null },
    ],
  };
  const answer = (url: string) =>
    url.includes("/items?id=") ? json(source) : json({ id: "d", revision: 1 });
  const body = (calls: { url: string; init: RequestInit }[]) =>
    JSON.parse(String(calls.find((c) => c.url.endsWith("/drafts"))!.init.body)) as Record<
      string,
      unknown
    >;
  const base = { to: ["a@example.com"], subject: "s", text: "t", expected_revision: 4 };

  it("edits a draft as its own source and keeps its attachments unless told otherwise", async () => {
    const { tools, calls } = setup(answer);
    await tools.get("mailbox_save_draft")!({ ...base, id: source.id });
    expect(body(calls)).toMatchObject({
      id: source.id,
      sourceItemId: source.id,
      retainedAttachments: [0, 1],
      uploads: [],
    });
    const removing = setup(answer);
    await removing.tools.get("mailbox_save_draft")!({
      ...base,
      id: source.id,
      keep_attachments: [],
    });
    expect(body(removing.calls)).toMatchObject({ retainedAttachments: [] });
    // Keeping none needs no read of the source.
    expect(removing.calls.filter((c) => c.url.includes("/items?id="))).toHaveLength(0);
  });

  it("forwards with the selected attachments plus new files; a reply keeps none", async () => {
    const { tools, calls } = setup(answer);
    const added = randomBytes(500);
    await tools.get("mailbox_save_draft")!({
      ...base,
      expected_revision: 0,
      source_item_id: source.id,
      mode: "forward",
      keep_attachments: [1],
      attachments: [{ filename: "novo.txt", content_base64: added.toString("base64") }],
    });
    expect(body(calls)).toMatchObject({
      sourceItemId: source.id,
      mode: "forward",
      retainedAttachments: [1],
      uploads: [{ filename: "novo.txt", base64: added.toString("base64") }],
    });
    const reply = setup(answer);
    await reply.tools.get("mailbox_save_draft")!({
      ...base,
      expected_revision: 0,
      source_item_id: source.id,
      mode: "reply",
    });
    expect(body(reply.calls)).toMatchObject({ retainedAttachments: [], uploads: [] });
  });

  it("refuses a file over the limit before calling the server", async () => {
    const { tools, calls } = setup(answer);
    const result = await tools.get("mailbox_save_draft")!({
      ...base,
      expected_revision: 0,
      attachments: [
        { filename: "grande.zip", content_base64: randomBytes(300 * 1024).toString("base64") },
      ],
    });
    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({
      error: "attachments",
      hint: expect.stringMatching(/grande\.zip.*256 KiB/),
    });
    expect(calls).toHaveLength(0);
  });
});
