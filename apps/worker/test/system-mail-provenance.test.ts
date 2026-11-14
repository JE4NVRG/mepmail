import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  acceptEmail,
  decryptEmailBody,
  EnvKeyring,
  encryptEmailBody,
  encryptPayload,
  generateApiKey,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  SYSTEM_MAIL_TAG,
  type SystemMailKind,
  sendSystemMail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApi } from "../../api/src/app.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
let token: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const content = {
  html: '<p>Your receipt</p><a href="https://origin.example/receipt">View</a>',
  text: "Your receipt",
};
const message = {
  from: "Service <account@origin.example>",
  to: ["r@example.com"],
  subject: "Receipt",
  ...content,
};
const rowFor = async (id: string) =>
  (await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]!;
const samplesFor = (id: string) =>
  db.select().from(schema.monitorSamples).where(eq(schema.monitorSamples.emailId, id));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "system-origin");
  await db
    .update(schema.teams)
    .set({ createdAt: new Date("2025-01-01"), sendReviewClearedAt: new Date("2026-01-01") })
    .where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "origin.example",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
      openTracking: true,
    })
    .returning();
  domainId = domain!.id;
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "fixture",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
});
afterAll(() => close());
function dispatch() {
  const sendRaw = vi.fn(async (_params: { raw: Buffer }) => ({ messageId: randomUUID() }));
  const enqueueJudge = vi.fn(async (_id: string) => {});
  // Every candidate is sampled deterministically without changing production defaults.
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => MONITOR_SETTING_DEFAULTS,
    enqueueJudge,
  };
  const deps: SendDeps = {
    keyring,
    ses: { sendRaw },
    monitor,
    tracking: { secretKey: Buffer.alloc(32, 8), defaultBaseUrl: "https://track.example" },
  };
  return { deps, sendRaw, enqueueJudge };
}
async function accept(tags?: Record<string, string>) {
  const result = await acceptEmail(
    { db, keyring, isCloud: false, enqueueEmailSend: async () => {} },
    { teamId, billing: "uncapped", apiKeyId: null },
    { ...message, domainId, tags },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.id;
}
async function system(kind: SystemMailKind) {
  let id = "";
  expect(
    await sendSystemMail(
      {
        db,
        keyring,
        isCloud: false,
        enqueueEmailSend: async (emailId) => {
          id = emailId;
        },
        raw: async () => {
          throw new Error("unexpected raw fallback");
        },
      },
      { ...message, to: message.to[0]!, kind },
    ),
  ).toBe("pipeline");
  return id;
}
function sealed(row: Awaited<ReturnType<typeof rowFor>>) {
  return {
    ciphertext: row.bodyCiphertext!,
    iv: row.bodyIv!,
    wrappedDek: row.bodyWrappedDek!,
    keyVersion: row.bodyKeyVersion!,
  };
}
it("actual public POST with the canonical tag neither skips monitoring nor purges evidence", async () => {
  const app = createApi({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });
  for (const tags of [undefined, [{ name: SYSTEM_MAIL_TAG, value: "password_reset" }]]) {
    const response = await app.request("/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...message,
        tags,
        origin: { version: 1, source: "system", kind: "password_reset" },
      }),
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    const d = dispatch();
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("sent");
    expect(d.sendRaw).toHaveBeenCalledTimes(1);
    expect(await samplesFor(id)).toHaveLength(1);
    expect(d.enqueueJudge).toHaveBeenCalledTimes(1);
    const row = await rowFor(id);
    expect(row.bodyPurgedAt).toBeNull();
    expect(row.bodyCiphertext).not.toBeNull();
    const mime = d.sendRaw.mock.calls[0]![0].raw.toString();
    expect(mime).toContain("/t/c/");
    expect(mime).not.toContain('"origin"');
    expect(await decryptEmailBody(sealed(row), keyring, { teamId, rowId: id })).toEqual(content);
  }
});
it("null API key, uncapped billing and a forged queued-row tag do not authenticate origin", async () => {
  const id = await accept();
  await db
    .update(schema.emails)
    .set({ tags: { [SYSTEM_MAIL_TAG]: "password_reset" } })
    .where(eq(schema.emails.id, id));
  const d = dispatch();
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("sent");
  expect(await samplesFor(id)).toHaveLength(1);
  expect((await rowFor(id)).bodyPurgedAt).toBeNull();
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("skipped");
  expect(d.sendRaw).toHaveBeenCalledTimes(1);
});
it.each(["password_reset", "email_verification", "invitation", "updates.confirm"] as const)(
  "real %s is untracked, not modeled and purged even if its public tag changes",
  async (kind) => {
    const id = await system(kind);
    const before = await rowFor(id);
    expect(await decryptEmailBody(sealed(before), keyring, { teamId, rowId: id })).toEqual(content);
    await db
      .update(schema.emails)
      .set({ tags: { [SYSTEM_MAIL_TAG]: "domain.verified" } })
      .where(eq(schema.emails.id, id));
    const d = dispatch();
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("sent");
    expect(await samplesFor(id)).toEqual([]);
    expect(d.enqueueJudge).not.toHaveBeenCalled();
    expect(d.sendRaw.mock.calls[0]![0].raw.toString()).not.toContain("/t/c/");
    expect((await rowFor(id)).bodyCiphertext).toBeNull();
    expect((await rowFor(id)).bodyPurgedAt).toBeInstanceOf(Date);
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("skipped");
    expect(d.sendRaw).toHaveBeenCalledTimes(1);
  },
);
it("a genuine noncredential notice retains its body even with a credential tag", async () => {
  const id = await system("domain.verified");
  await db
    .update(schema.emails)
    .set({ tags: { [SYSTEM_MAIL_TAG]: "password_reset" } })
    .where(eq(schema.emails.id, id));
  const d = dispatch();
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("sent");
  expect((await rowFor(id)).bodyPurgedAt).toBeNull();
  expect(await samplesFor(id)).toEqual([]);
});
it.each([false, true])(
  "legacy tagged snapshot (bound=%s) parks for producer reissue without sending, modeling or destroying credentials",
  async (bound) => {
    const id = await accept();
    const legacy = await encryptPayload(
      gzipSync(Buffer.from(JSON.stringify(content))),
      keyring,
      bound ? { teamId, rowId: id, kind: "email_body" } : undefined,
    );
    await db
      .update(schema.emails)
      .set({
        tags: { [SYSTEM_MAIL_TAG]: "password_reset" },
        bodyCiphertext: legacy.ciphertext,
        bodyIv: legacy.iv,
        bodyWrappedDek: legacy.wrappedDek,
        bodyKeyVersion: legacy.keyVersion,
      })
      .where(eq(schema.emails.id, id));
    const d = dispatch();
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("parked");
    expect(d.sendRaw).not.toHaveBeenCalled();
    expect(d.enqueueJudge).not.toHaveBeenCalled();
    expect((await rowFor(id)).sentAt).toBeNull();
    expect((await rowFor(id)).bodyCiphertext).toEqual(legacy.ciphertext);
  },
);
it("row/team replay and ciphertext tampering fail authentication before any transport or monitor", async () => {
  const original = await rowFor(await system("password_reset"));
  const otherTeam = await createTeam(db, "other-origin");
  for (const changes of [{ teamId }, { teamId: otherTeam }, { teamId, tamper: true }]) {
    const id = await accept();
    const ciphertext = Buffer.from(original.bodyCiphertext!);
    if ("tamper" in changes) ciphertext[0] = ciphertext[0]! ^ 1;
    await db
      .update(schema.emails)
      .set({
        teamId: changes.teamId,
        bodyCiphertext: ciphertext,
        bodyIv: original.bodyIv,
        bodyWrappedDek: original.bodyWrappedDek,
        bodyKeyVersion: original.bodyKeyVersion,
        tags: { [SYSTEM_MAIL_TAG]: "password_reset" },
      })
      .where(eq(schema.emails.id, id));
    const d = dispatch();
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("failed");
    expect(d.sendRaw).not.toHaveBeenCalled();
    expect(d.enqueueJudge).not.toHaveBeenCalled();
  }
});
it("changing the destination of genuine account mail requires reissue, not customer-model fallback", async () => {
  const id = await system("password_reset");
  await db
    .update(schema.emails)
    .set({ to: ["other@example.com"], tags: null })
    .where(eq(schema.emails.id, id));
  const d = dispatch();
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("parked");
  expect(d.sendRaw).not.toHaveBeenCalled();
  expect(d.enqueueJudge).not.toHaveBeenCalled();
  expect((await rowFor(id)).bodyCiphertext).not.toBeNull();
});
it("caller-supplied body metadata is discarded by the ordinary encryption writer", async () => {
  const id = randomUUID();
  const body = { ...content, origin: { version: 1, source: "system", kind: "password_reset" } };
  const encrypted = await encryptEmailBody(body, keyring, { teamId, rowId: id });
  const { decryptEmailBodySnapshot } = await import(
    "../../../packages/core/src/crypto/envelope.js"
  );
  expect(
    (await decryptEmailBodySnapshot(encrypted, keyring, { teamId, rowId: id })).origin,
  ).toEqual({ version: 1, source: "customer" });
});
