import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  domainBrandKey,
  findPhishingRecidivismDomainMatch,
  phishingBrandKey,
} from "../src/phishing-recidivism.js";

describe("phishing recidivism keys", () => {
  it("normalizes lookalike team names while ignoring generic short names", () => {
    expect(phishingBrandKey("acmebr")).toBe("acmebr");
    expect(phishingBrandKey("Acmé-BR!")).toBe("acmebr");
    expect(phishingBrandKey("abc")).toBeNull();
    expect(phishingBrandKey("Agency")).toBeNull();
    expect(phishingBrandKey("testing")).toBeNull();
  });

  it("extracts organizational brand labels across subdomains and multi-part TLDs", () => {
    expect(domainBrandKey("acmebr.com")).toBe("acmebr");
    expect(domainBrandKey("mail.acmebr.net")).toBe("acmebr");
    expect(domainBrandKey("envio.banco-seguro.com.br")).toBe("bancoseguro");
    expect(domainBrandKey("mail.acmehelp.co.uk")).toBe("acmehelp");
    expect(domainBrandKey("mail.banco-seguro.com.pt")).toBe("bancoseguro");
    expect(domainBrandKey("test.com")).toBeNull();
  });
});

describe("findPhishingRecidivismDomainMatch", () => {
  let db: Db;
  let close: () => Promise<void>;
  let priorTeamId: string;
  let newTeamId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    priorTeamId = await createTeam(db, "Acmé-BR");
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
      .where(eq(schema.teams.id, priorTeamId));
    await db.insert(schema.domains).values({
      teamId: priorTeamId,
      name: "itau.com",
      region: "us-east-1",
    });
    newTeamId = await createTeam(db, "Fresh Team");
  });

  afterAll(async () => {
    await close();
  });

  it("matches exact suspended domains even when the brand key is short or generic", async () => {
    await expect(
      findPhishingRecidivismDomainMatch(db, { teamId: newTeamId, domain: "itau.com" }),
    ).resolves.toMatchObject({ source: "suspended_domain", matchedTeamId: priorTeamId });
  });

  it("matches brand keys in subdomains and multi-part TLDs like .com.pt", async () => {
    await expect(
      findPhishingRecidivismDomainMatch(db, {
        teamId: newTeamId,
        domain: "acmebr.attacker.com",
      }),
    ).resolves.toMatchObject({ source: "team_name", matchedTeamId: priorTeamId, key: "acmebr" });
    await expect(
      findPhishingRecidivismDomainMatch(db, {
        teamId: newTeamId,
        domain: "mail.acme-br.com.pt",
      }),
    ).resolves.toMatchObject({ source: "team_name", matchedTeamId: priorTeamId, key: "acmebr" });
  });
});
