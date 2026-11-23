import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { alertSignupWave } from "../src/handlers/signup-wave.js";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-11-19T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function signup(at: Date, emailDomain: string): Promise<void> {
  const teamId = await createTeam(db, `wave-${randomUUID()}`);
  await db.update(schema.teams).set({ createdAt: at }).where(eq(schema.teams.id, teamId));
  const userId = randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    name: "Wave",
    email: `${randomUUID()}@${emailDomain}`,
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it("alerta uma vez por onda, nao a cada rodada", async () => {
  const sent: string[] = [];
  const notify = (text: string) => sent.push(text);

  // Base calma: nada a dizer.
  expect((await alertSignupWave(db, { now: NOW, notify })).alerted).toBe(false);
  expect(sent).toHaveLength(0);

  // A forma da onda: doze times, quatro dominios de e-mail, uma hora.
  for (let i = 0; i < 12; i++) {
    await signup(minutesAgo(5 + i), `farm${i % 4}.shop`);
  }

  const first = await alertSignupWave(db, { now: NOW, notify });
  expect(first.alerted).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("padrao de onda");
  expect(sent[0]).not.toContain("@");

  // Segunda rodada na mesma janela: o audit e o dedupe.
  const second = await alertSignupWave(db, { now: new Date(NOW.getTime() + 60_000), notify });
  expect(second.alerted).toBe(false);
  expect(sent).toHaveLength(1);
});
