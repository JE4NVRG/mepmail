import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import type { InvitationMailActor } from "../src/invitation-mail-actor.js";
import { hashRecipient } from "../src/suppressions.js";
import { type SystemMailMessage, sendSystemMail } from "../src/system-mail.js";

let db: Db;
let close: () => Promise<void>;
let owner: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  owner = await createTeam(db, "compat-platform");
  await db.insert(schema.domains).values({
    teamId: owner,
    name: "platform.example",
    status: "verified",
    region: "us-east-1",
    verifiedAt: new Date(),
  });
});
afterAll(() => close());
async function fixture() {
  const teamId = await createTeam(db, `actor-${randomUUID()}`);
  const userId = randomUUID();
  const recipient = `${randomUUID()}@recipient.test`;
  await db
    .insert(schema.user)
    .values({ id: userId, name: "issuer", email: `${userId}@sender.test`, emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  const [invitation] = await db
    .insert(schema.teamInvitations)
    .values({
      teamId,
      email: recipient,
      role: "member",
      invitedByUserId: userId,
      expiresAt: new Date(Date.now() + 86400000),
    })
    .returning();
  const actor: InvitationMailActor = { teamId, userId, invitationId: invitation!.id };
  const message: SystemMailMessage = {
    from: "MepMail <notice@unowned.example>",
    to: recipient,
    kind: "invitation",
    subject: "MepMail invitation",
    text: "Open your MepMail invitation.",
    html: "<p>Open your MepMail invitation.</p>",
  };
  const raw = vi.fn(async () => {});
  const enqueueEmailSend = vi.fn(async () => {});
  const deps = { db, keyring, raw, enqueueEmailSend, isCloud: false };
  return { actor, message, raw, enqueueEmailSend, deps };
}
it("explicit self-host preserves unowned-sender immediate raw compatibility with a current real actor", async () => {
  const f = await fixture();
  expect(await sendSystemMail(f.deps, f.message, f.actor)).toBe("raw");
  expect(f.raw).toHaveBeenCalledExactlyOnceWith(f.message, null);
  expect(f.enqueueEmailSend).not.toHaveBeenCalled();
});
it.each([true, undefined])(
  "Cloud/default %s does not raw-send the same legitimate invitation",
  async (isCloud) => {
    const f = await fixture();
    const { isCloud: _mode, ...base } = f.deps;
    await expect(
      sendSystemMail(
        { ...base, ...(isCloud === undefined ? {} : { isCloud }) },
        f.message,
        f.actor,
      ),
    ).rejects.toMatchObject({ name: "SystemMailUnavailable", reason: "sender_unowned" });
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.enqueueEmailSend).not.toHaveBeenCalled();
  },
);
it.each([
  "suspended",
  "revoked",
  "optout",
  "zero-ceiling",
  "demoted",
  "expired",
  "missing-actor",
] as const)("explicit self-host cannot raw-send a %s actor", async (kind) => {
  const f = await fixture();
  if (kind === "suspended")
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "manual" })
      .where(eq(schema.teams.id, f.actor.teamId));
  if (kind === "revoked")
    await db
      .delete(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, f.actor.invitationId));
  if (kind === "optout")
    await db.insert(schema.suppressions).values({
      teamId: f.actor.teamId,
      email: f.message.to,
      emailHash: hashRecipient(f.message.to),
      reason: "one_click_unsubscribe",
    });
  if (kind === "zero-ceiling")
    await db
      .update(schema.teams)
      .set({ dailySendCeiling: 0 })
      .where(eq(schema.teams.id, f.actor.teamId));
  if (kind === "demoted")
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.teamMembers.teamId, f.actor.teamId),
          eq(schema.teamMembers.userId, f.actor.userId),
        ),
      );
  if (kind === "expired")
    await db
      .update(schema.teamInvitations)
      .set({ expiresAt: new Date("2000-01-01") })
      .where(eq(schema.teamInvitations.id, f.actor.invitationId));
  await expect(
    sendSystemMail(f.deps, f.message, kind === "missing-actor" ? undefined : f.actor),
  ).rejects.toMatchObject({ name: "SystemMailRefused" });
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.enqueueEmailSend).not.toHaveBeenCalled();
});
it.each(["unchanged", "suspended", "revoked", "actor-optout", "owner-optout"] as const)(
  "rechecks current authority after owned-sender accept failure (%s)",
  async (change) => {
    const f = await fixture();
    const m = { ...f.message, from: "MepMail <notice@platform.example>" };
    const wrapDek = vi.fn(async () => {
      if (change === "suspended")
        await db
          .update(schema.teams)
          .set({ suspendedAt: new Date(), suspensionReason: "manual" })
          .where(eq(schema.teams.id, f.actor.teamId));
      if (change === "revoked")
        await db
          .delete(schema.teamInvitations)
          .where(eq(schema.teamInvitations.id, f.actor.invitationId));
      if (change === "actor-optout" || change === "owner-optout")
        await db.insert(schema.suppressions).values({
          teamId: change === "actor-optout" ? f.actor.teamId : owner,
          email: m.to,
          emailHash: hashRecipient(m.to),
          reason: "one_click_unsubscribe",
        });
      throw new Error("synthetic KMS outage after policy mutation");
    });
    const deps = { ...f.deps, keyring: { wrapDek, unwrapDek: keyring.unwrapDek.bind(keyring) } };
    if (change === "unchanged") {
      expect(await sendSystemMail(deps, m, f.actor)).toBe("raw");
      expect(f.raw).toHaveBeenCalledTimes(1);
    } else {
      await expect(sendSystemMail(deps, m, f.actor)).rejects.toMatchObject({
        name: "SystemMailRefused",
      });
      expect(f.raw).not.toHaveBeenCalled();
    }
    expect(wrapDek).toHaveBeenCalledTimes(1);
    expect(f.enqueueEmailSend).not.toHaveBeenCalled();
  },
);
