import { randomBytes, randomUUID } from "node:crypto";
import {
  decryptEmailBody,
  EnvKeyring,
  hashRecipient,
  MONITOR_SETTING_DEFAULTS,
  sendSystemMail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSettingsRouter } from "@/server/routers/settings";
import { buildResetEmail, buildVerificationEmail, type SystemMailDeps } from "@/server/system-mail";
import { createCallerFactory, router } from "@/server/trpc";
import {
  decryptEmailBodySnapshot,
  encryptEmailBody,
} from "../../../packages/core/src/crypto/envelope.js";
import type { InvitationMailActor } from "../../../packages/core/src/invitation-mail-actor.js";
import { type SendDeps, sendEmail } from "../../worker/src/handlers/send-email.js";

// Synthetic migrated DB only; network transport and model are injected.
let db: Db, close: () => Promise<void>, platform: string, a: string, b: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
let enqueued: string[];
let raw: ReturnType<typeof vi.fn<() => Promise<void>>>;
let capturedActor: InvitationMailActor | undefined;
let capturedMessage: Parameters<typeof sendSystemMail>[1];
const row = async (id: string) =>
  (await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]!;
const sealed = (r: Awaited<ReturnType<typeof row>>) => ({
  ciphertext: r.bodyCiphertext!,
  iv: r.bodyIv!,
  wrappedDek: r.bodyWrappedDek!,
  keyVersion: r.bodyKeyVersion!,
});
function pipeline() {
  return {
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async (id: string) => {
      enqueued.push(id);
    },
    raw,
  };
}
function caller(userId: string, teamId: string) {
  const mail: SystemMailDeps = {
    send: async (message, actor) => {
      capturedActor = actor;
      capturedMessage = message;
      await sendSystemMail(pipeline(), message, actor);
    },
  };
  return createCallerFactory(router({ settings: createSettingsRouter(undefined, mail) }))({
    db,
    session: { user: { id: userId, name: userId, email: `${userId}@example.com` } },
    teamId,
    role: "owner",
  });
}
function dispatcher(throttle?: () => Promise<void>) {
  const sendRaw = vi.fn(async () => ({ messageId: randomUUID() }));
  const enqueueJudge = vi.fn(async () => {});
  const deps: SendDeps = {
    keyring,
    ses: { sendRaw },
    throttle,
    monitor: {
      samplingKey: Buffer.alloc(32, 7),
      settings: async () => MONITOR_SETTING_DEFAULTS,
      enqueueJudge,
    },
  };
  return { sendRaw, enqueueJudge, deps };
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  enqueued = [];
  capturedActor = undefined;
  raw = vi.fn(async () => {
    throw new Error("raw transport forbidden");
  });
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-invitation-fixture-only");
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <no-reply@platform.example>");
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MepMail <no-reply@platform.example>");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "true");
  await db.insert(schema.user).values({
    id: "root",
    name: "root",
    email: "root@example.com",
    createdAt: new Date("2000-01-01"),
  });
  platform = await createTeam(db, "platform");
  a = await createTeam(db, "actor-a");
  b = await createTeam(db, "actor-b");
  await db.insert(schema.domains).values({
    teamId: platform,
    name: "platform.example",
    status: "verified",
    region: "us-east-1",
    verifiedAt: new Date(),
  });
  for (const [teamId, userId] of [
    [a, "alice"],
    [b, "bob"],
  ] as const) {
    await db
      .insert(schema.user)
      .values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true });
    await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

it.each(["suspended", "held"])(
  "real settings caller cannot borrow platform authority when actor is %s",
  async (kind) => {
    await db
      .update(schema.teams)
      .set(
        kind === "suspended"
          ? { suspendedAt: new Date(), suspensionReason: "manual" }
          : { sendReviewAt: new Date(), sendReviewReason: "content" },
      )
      .where(eq(schema.teams.id, a));
    const result = await caller("alice", a).settings.invitations.create({
      email: "recipient@example.com",
    });
    expect(result.emailed).toBe(false);
    expect(enqueued).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
  },
);
it("two independent legitimate teams use only the sender owner; retry dispatch sends once without customer-domain prerequisite", async () => {
  for (const [teamId, userId, recipient] of [
    [a, "alice", "one@example.com"],
    [b, "bob", "two@example.com"],
  ] as const) {
    const result = await caller(userId, teamId).settings.invitations.create({ email: recipient });
    expect(result.emailed).toBe(true);
    const id = enqueued.at(-1)!;
    const r = await row(id);
    expect(r.teamId).toBe(platform);
    expect(capturedActor).toEqual({ teamId, userId, invitationId: result.id });
    const snapshot = await decryptEmailBodySnapshot(sealed(r), keyring, {
      teamId: platform,
      rowId: id,
    });
    expect(snapshot.origin).toMatchObject({
      source: "system",
      kind: "invitation",
      actor: capturedActor,
    });
    expect(
      await decryptEmailBody(sealed(r), keyring, { teamId: platform, rowId: id }),
    ).not.toHaveProperty("origin");
    const d = dispatcher();
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("sent");
    expect(await sendEmail(db, d.deps, { emailId: id })).toBe("skipped");
    expect(d.sendRaw).toHaveBeenCalledTimes(1);
    expect(d.enqueueJudge).not.toHaveBeenCalled();
  }
  expect(
    await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, a)),
  ).toEqual([]);
  expect(
    await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, b)),
  ).toEqual([]);
  const [usage] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, platform));
  expect(usage?.accepted).toBe(2);
});
it.each([
  "removed-member",
  "suspended",
  "held",
  "actor-optout",
  "platform-optout",
  "invite-revoked",
])("revalidates %s introduced between accept and final claim", async (kind) => {
  await caller("alice", a).settings.invitations.create({ email: "recipient@example.com" });
  const id = enqueued[0]!;
  const d = dispatcher(async () => {
    if (kind === "removed-member")
      await db
        .delete(schema.teamMembers)
        .where(and(eq(schema.teamMembers.teamId, a), eq(schema.teamMembers.userId, "alice")));
    if (kind === "suspended")
      await db
        .update(schema.teams)
        .set({ suspendedAt: new Date(), suspensionReason: "manual" })
        .where(eq(schema.teams.id, a));
    if (kind === "held")
      await db
        .update(schema.teams)
        .set({ sendReviewAt: new Date(), sendReviewReason: "content" })
        .where(eq(schema.teams.id, a));
    if (kind.endsWith("optout"))
      await db.insert(schema.suppressions).values({
        teamId: kind === "actor-optout" ? a : platform,
        email: "recipient@example.com",
        emailHash: hashRecipient("recipient@example.com"),
        reason: "one_click_unsubscribe",
      });
    if (kind === "invite-revoked")
      await db
        .delete(schema.teamInvitations)
        .where(eq(schema.teamInvitations.id, capturedActor!.invitationId));
  });
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe(
    kind === "removed-member" || kind === "invite-revoked" ? "failed" : "parked",
  );
  expect(d.sendRaw).not.toHaveBeenCalled();
  expect(d.enqueueJudge).not.toHaveBeenCalled();
  expect((await row(id)).bodyCiphertext).not.toBeNull();
});
it("internal actor context mismatch and forged actor user fail before enqueue; payload fields never supply authority", async () => {
  await caller("alice", a).settings.invitations.create({ email: "recipient@example.com" });
  for (const forged of [
    { ...capturedActor!, teamId: b },
    { ...capturedActor!, userId: "stranger" },
  ]) {
    await expect(sendSystemMail(pipeline(), capturedMessage, forged)).rejects.toMatchObject({
      name: "SystemMailRefused",
    });
  }
  await expect(
    sendSystemMail(pipeline(), {
      ...capturedMessage,
      actor: capturedActor,
    } as typeof capturedMessage),
  ).rejects.toMatchObject({ name: "SystemMailRefused" });
  expect(enqueued).toHaveLength(1);
  expect(raw).not.toHaveBeenCalled();
  await expect(
    caller("alice", b).settings.invitations.create({ email: "other@example.com" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("legacy sealed invitation without actor holds for explicit reissue, never re-stamps, sends or models", async () => {
  await caller("alice", a).settings.invitations.create({ email: "recipient@example.com" });
  const id = enqueued[0]!,
    r = await row(id);
  const snapshot = await decryptEmailBodySnapshot(sealed(r), keyring, {
    teamId: platform,
    rowId: id,
  });
  if (snapshot.origin?.source !== "system") throw new Error("missing system origin");
  const { actor: _actor, ...legacyOrigin } = snapshot.origin;
  const legacy = await encryptEmailBody(
    snapshot.body,
    keyring,
    { teamId: platform, rowId: id },
    legacyOrigin,
  );
  await db
    .update(schema.emails)
    .set({
      bodyCiphertext: legacy.ciphertext,
      bodyIv: legacy.iv,
      bodyWrappedDek: legacy.wrappedDek,
      bodyKeyVersion: legacy.keyVersion,
    })
    .where(eq(schema.emails.id, id));
  const d = dispatcher();
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("failed");
  expect(await sendEmail(db, d.deps, { emailId: id })).toBe("skipped");
  expect(d.sendRaw).not.toHaveBeenCalled();
  expect(d.enqueueJudge).not.toHaveBeenCalled();
  expect(Buffer.from((await row(id)).bodyCiphertext!)).toEqual(legacy.ciphertext);
});
it("reset and verification keep the existing actor-free credential path", async () => {
  for (const message of [
    buildResetEmail({
      to: "reset@example.com",
      name: "ignored",
      url: "https://app.example/reset/synthetic",
      locale: "en",
    }),
    buildVerificationEmail({
      to: "verify@example.com",
      name: "ignored",
      url: "https://app.example/verify/synthetic",
      locale: "en",
    }),
  ]) {
    await sendSystemMail(pipeline(), message);
    const d = dispatcher();
    expect(await sendEmail(db, d.deps, { emailId: enqueued.at(-1)! })).toBe("sent");
    expect(d.sendRaw).toHaveBeenCalledTimes(1);
    expect(d.enqueueJudge).not.toHaveBeenCalled();
  }
});
