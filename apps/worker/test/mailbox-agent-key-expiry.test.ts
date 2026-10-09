import type { ExpiringMailboxAgentCredential } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  MAILBOX_AGENT_KEY_WARN_MS,
  warnExpiringMailboxAgentKeys,
} from "../src/handlers/mailbox-agent-key-expiry.js";
import type { SystemMailer } from "../src/system-mail.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "agents");
});
afterAll(() => close());

const now = new Date(Date.UTC(2026, 9, 9, 12));

it("warns each credential's owner once, naming the mailboxes and the date", async () => {
  const sent: { to: string; subject: string; text: string; kind: string }[] = [];
  const mailer = {
    send: async (to: string, m: { subject: string; text: string; kind: string }) => {
      sent.push({ to, subject: m.subject, text: m.text, kind: m.kind });
    },
  } as unknown as SystemMailer;
  const asked: number[] = [];
  const credentials: ExpiringMailboxAgentCredential[] = [
    {
      credentialId: "11111111-1111-4111-8111-111111111111",
      teamId,
      ownerUserId: "owner",
      email: "owner@example.invalid",
      label: "Sage",
      expiresAt: new Date(Date.UTC(2026, 9, 14)),
      addresses: ["a@x.invalid", "b@x.invalid", "c@x.invalid", "d@x.invalid", "e@x.invalid"],
    },
    {
      credentialId: "22222222-2222-4222-8222-222222222222",
      teamId,
      ownerUserId: "owner",
      email: "owner@example.invalid",
      label: "Suporte",
      expiresAt: new Date(Date.UTC(2026, 9, 15)),
      addresses: ["suporte@x.invalid"],
    },
  ];
  const run = () =>
    warnExpiringMailboxAgentKeys(db, {
      mailer,
      appBaseUrl: "https://app.example",
      now,
      list: async (_db, params) => {
        asked.push(params.within);
        return credentials;
      },
    });

  expect(await run()).toEqual({ sent: 2 });
  expect(asked).toEqual([MAILBOX_AGENT_KEY_WARN_MS]);
  expect(sent.map((m) => [m.to, m.kind])).toEqual([
    ["owner@example.invalid", "mailbox.agent_key_expiring"],
    ["owner@example.invalid", "mailbox.agent_key_expiring"],
  ]);
  expect(sent[0]?.subject).toBe("Agent key Sage expires on October 14, 2026");
  expect(sent[0]?.text).toContain("a@x.invalid, b@x.invalid, c@x.invalid and 2 more mailboxes");
  expect(sent[0]?.text).toContain("https://app.example/mail/settings#agents");
  expect(sent[1]?.text).toContain("gives access to suporte@x.invalid, expires");

  // The claim is per credential: the next sweeps stay silent.
  expect(await run()).toEqual({ sent: 0 });
  expect(sent).toHaveLength(2);
});
