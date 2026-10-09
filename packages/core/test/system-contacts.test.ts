import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { enrollSystemContact, syncSystemContactLocale } from "../src/system-contacts.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "home");
});
afterAll(async () => {
  await close();
});

const localeOf = async (email: string) =>
  (
    await db
      .select({ properties: schema.contacts.properties })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, email))
  )[0]?.properties?.locale;

it("a later dashboard language replaces the one guessed at sign-up, and only writes on a change", async () => {
  await enrollSystemContact(db, teamId, {
    email: "pessoa@example.com",
    name: "Pessoa",
    locale: "en",
  });
  // Enrollment never rewrites an existing contact, whatever language it brings.
  await enrollSystemContact(db, teamId, {
    email: "pessoa@example.com",
    name: "Pessoa",
    locale: "pt-BR",
  });
  expect(await localeOf("pessoa@example.com")).toBe("en");
  expect(await syncSystemContactLocale(db, teamId, "Pessoa@Example.com", "pt-BR")).toBe(true);
  expect(await localeOf("pessoa@example.com")).toBe("pt-BR");
  expect(await syncSystemContactLocale(db, teamId, "pessoa@example.com", "pt-BR")).toBe(false);
  // The other properties stay as they were.
  const [row] = await db
    .select({ properties: schema.contacts.properties })
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "pessoa@example.com"));
  expect(row?.properties).toMatchObject({ source: "signup", locale: "pt-BR" });
  // No contact, nothing to write: the account was never enrolled.
  expect(await syncSystemContactLocale(db, teamId, "nobody@example.com", "pt-BR")).toBe(false);
});
