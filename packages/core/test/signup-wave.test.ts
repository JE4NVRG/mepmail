import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  detectSignupWave,
  isSignupWave,
  SIGNUP_WAVE_DEFAULT,
  signupWaveText,
} from "../src/signup-wave.js";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-11-19T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function signup(at: Date, emailDomain = "agent.example"): Promise<void> {
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
// Cada caso mede a propria janela: nada de times de outro teste na conta.
beforeEach(async () => {
  await db.delete(schema.teams);
});
afterAll(() => close());

it("nao chama de onda uma base parada", async () => {
  const before = await detectSignupWave(db, { now: NOW });
  expect(before.windowMinutes).toBe(SIGNUP_WAVE_DEFAULT.windowMinutes);
  expect(isSignupWave(before)).toBe(false);
});

it("reconhece a forma da onda: muitos times, poucos dominios, na mesma hora", async () => {
  for (let i = 0; i < 12; i++) {
    await signup(minutesAgo(5 + i), `farm${i % 4}.shop`);
  }
  const wave = await detectSignupWave(db, { now: NOW });
  expect(wave.teams).toBe(12);
  expect(wave.emailDomains).toBe(4);
  expect(isSignupWave(wave)).toBe(true);
  const text = signupWaveText(wave);
  expect(text).toContain("12 times");
  expect(text).not.toContain("@");
});

it("ignora o que ficou fora da janela", async () => {
  const wave = await detectSignupWave(db, { now: NOW, thresholds: { windowMinutes: 1 } });
  expect(isSignupWave(wave)).toBe(false);
});

it("provedores grandes nao contam como variedade de dominios", async () => {
  // 20 contas em gmail/outlook na mesma hora: campanha legitima, nao onda.
  for (let i = 0; i < 14; i++) await signup(minutesAgo(3), "gmail.com");
  for (let i = 0; i < 6; i++) await signup(minutesAgo(2), "outlook.com");
  const wave = await detectSignupWave(db, { now: NOW, thresholds: { windowMinutes: 60 } });
  expect(wave.teams).toBeGreaterThanOrEqual(20);
  expect(wave.emailDomains).toBe(1);
  expect(isSignupWave(wave, { windowMinutes: 60, maxTeams: 100, maxEmailDomains: 5 })).toBe(false);
});
