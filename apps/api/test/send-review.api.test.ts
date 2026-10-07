import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
const enqueued: string[] = [];

// Cyrillic В а с о around a Latin n, then С Т Т wholly in Cyrillic.
const DISGUISED = "Ваnсо СТТ";

async function call(method: string, path: string, payload?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "review-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async (id) => {
      enqueued.push(id);
    },
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});
afterAll(() => close());

it("refuses a disguised sender on single, batch and broadcast sends with 422", async () => {
  const disguised = {
    from: `"${DISGUISED}" <news@acme.dev>`,
    to: ["r@example.com"],
    subject: "Olá",
    text: "t",
  };
  const single = await call("POST", "/emails", disguised);
  expect(single.status).toBe(422);
  expect(await single.json()).toMatchObject({ name: "validation_error" });

  const batch = await call("POST", "/emails/batch", [disguised]);
  expect(batch.status).toBe(422);

  const [bc] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <hi@acme.dev>", subject: "Seu рedido", html: "<p>hi</p>" })
    .returning({ id: schema.broadcasts.id });
  const send = await call("POST", `/broadcasts/${bc?.id}/send`, {});
  expect(send.status).toBe(422);

  const rows = await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));
  expect(rows).toHaveLength(0);
});

it("accepts a young team's imitating send and holds the team for review", async () => {
  const res = await call("POST", "/emails", {
    from: "Banco CTT <news@acme.dev>",
    to: ["r@example.com"],
    subject: "Ação necessária: confirme os seus contactos",
    text: "t",
  });
  expect(res.status).toBe(200);
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sendReviewReason).toBe("impersonation");
  const flags = await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId));
  expect(flags).toMatchObject([{ reason: "review", status: "open" }]);
});
