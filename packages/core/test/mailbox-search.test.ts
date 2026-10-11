import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { setMailboxItemStar } from "../src/mailbox-organization.js";
import {
  importMailboxMime,
  saveMailboxDraft,
  setMailboxItemTrash,
} from "../src/mailbox-private-store.js";
import { createMailboxRegistry } from "../src/mailbox-registry.js";
import {
  deriveMailboxSearchKey,
  findMailboxSearchMatches,
  indexMailboxSearch,
  type MailboxSearchDocument,
  mailboxSearchDocumentTokens,
  mailboxSearchPhraseText,
  mailboxSearchQueryEmpty,
  mailboxSearchQueryTokens,
  mailboxSearchTerms,
  parseMailboxSearchQuery,
} from "../src/mailbox-search.js";

const searchKey = deriveMailboxSearchKey(randomBytes(32));
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));

/** A tiny reader for the synthetic messages below (the worker uses mailparser). */
async function read(raw: Buffer): Promise<MailboxSearchDocument> {
  const text = raw.toString("utf8");
  const [head = "", body = ""] = text.split(/\r?\n\r?\n/, 2);
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "im").exec(head)?.[1]?.trim() ?? "";
  const attachment = header("X-Attachment");
  return {
    subject: header("Subject"),
    from: [header("From")],
    to: [header("To"), header("Cc")].filter(Boolean),
    body,
    attachments: attachment ? [attachment] : [],
  };
}
const message = (subject: string, body: string, extra = "") =>
  Buffer.from(
    `From: Ana Souza <ana@cliente.invalid>\r\nTo: owner@box.invalid\r\nSubject: ${subject}\r\n${extra}\r\n${body}\r\n`,
  );

describe("search terms and queries", () => {
  it("compares words without accents or case, letters and digits only", () => {
    expect(mailboxSearchTerms("Ação de COBRANÇA nº 4812 — São Paulo!")).toEqual([
      "acao",
      "de",
      "cobranca",
      "no",
      "4812",
      "sao",
      "paulo",
    ]);
    expect(mailboxSearchPhraseText("Pedido   Nº 4812")).toBe(" pedido no 4812 ");
  });

  it("reads Portuguese and English operators, phrases and days", () => {
    const pt = parseMailboxSearchQuery(
      'de:ana assunto:"proposta piloto" tem:anexo depois:2026-10-01 antes:10/10/2026 "nota fiscal" contrato',
    );
    expect(pt.groups).toEqual([
      { field: "f", term: "ana" },
      { field: "s", term: "proposta" },
      { field: "s", term: "piloto" },
      { field: "any", term: "nota" },
      { field: "any", term: "fiscal" },
      { field: "any", term: "contrato" },
    ]);
    expect(pt.phrases).toEqual([" nota fiscal "]);
    expect(pt.hasAttachment).toBe(true);
    expect(pt.after?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(pt.before?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    const en = parseMailboxSearchQuery(
      "from:ana to:jean subject:invoice has:attachment after:2026-10-01",
    );
    expect(en.groups.map((g) => g.field)).toEqual(["f", "t", "s"]);
    expect(en.hasAttachment).toBe(true);
    // An unknown operator or a bad day is just words.
    expect(parseMailboxSearchQuery("foo:bar antes:ontem").groups.map((g) => g.term)).toEqual([
      "foo",
      "bar",
      "antes",
      "ontem",
    ]);
    expect(mailboxSearchQueryEmpty(parseMailboxSearchQuery(" a ! "))).toBe(true);
    expect(mailboxSearchQueryEmpty(parseMailboxSearchQuery("tem:anexo"))).toBe(false);
  });

  it("derives tokens per team: the same word never matches across teams", () => {
    const doc = { subject: "Proposta", from: [], to: [], body: "", attachments: [] };
    const a = mailboxSearchDocumentTokens(searchKey, "team-a", doc);
    const b = mailboxSearchDocumentTokens(searchKey, "team-b", doc);
    expect(a.some((t) => b.includes(t))).toBe(false);
    const query = mailboxSearchQueryTokens(searchKey, "team-a", parseMailboxSearchQuery("prop"));
    // Header prefixes from three letters match; the body keeps whole words only.
    expect(query[0]?.some((t) => a.includes(t))).toBe(true);
    const body = mailboxSearchDocumentTokens(searchKey, "team-a", {
      ...doc,
      subject: "",
      body: "proposta",
    });
    expect(query[0]?.some((t) => body.includes(t))).toBe(false);
    expect(
      mailboxSearchQueryTokens(searchKey, "team-a", parseMailboxSearchQuery("proposta"))[0]?.some(
        (t) => body.includes(t),
      ),
    ).toBe(true);
  });
});

describe("search index", () => {
  let db: Db;
  let close: () => Promise<void>;
  let teamId: string;
  let otherTeam: string;
  let mailboxId: string;
  let otherBox: string;
  const actor = () => ({ teamId, userId: "owner" });
  const imported = (
    subject: string,
    body: string,
    sourceId: string,
    extra = "",
    who = actor(),
    box = mailboxId,
  ) =>
    importMailboxMime(db, keys, who, {
      mailboxId: box,
      sourceId,
      raw: message(subject, body, extra),
    });
  const search = (
    query: string,
    options: {
      folder?: Parameters<typeof findMailboxSearchMatches>[1]["folder"];
      limit?: number;
      position?: { at: string; id: string };
      team?: string;
      boxes?: string[];
    } = {},
  ) => {
    const parsed = parseMailboxSearchQuery(query);
    const team = options.team ?? teamId;
    return findMailboxSearchMatches(db, {
      teamId: team,
      mailboxIds: options.boxes ?? [mailboxId],
      groups: mailboxSearchQueryTokens(searchKey, team, parsed),
      folder: options.folder ?? "all",
      after: parsed.after,
      before: parsed.before,
      position: options.position,
      limit: options.limit ?? 50,
    });
  };
  const sweep = () => indexMailboxSearch(db, keys, searchKey, read);

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    for (const file of readdirSync(extension)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(extension + file, "utf8").split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await db.execute(sql.raw(statement));
    teamId = await createTeam(db, "search-fixture");
    otherTeam = await createTeam(db, "search-other");
    await db.insert(schema.user).values([
      { id: "owner", name: "Owner", email: "owner@example.invalid" },
      { id: "outsider", name: "Outsider", email: "outsider@example.invalid" },
    ]);
    await db.insert(schema.teamMembers).values([
      { teamId, userId: "owner", role: "owner" },
      { teamId: otherTeam, userId: "outsider", role: "owner" },
    ]);
    const [domain, other] = await db
      .insert(schema.domains)
      .values([
        { teamId, name: "box.invalid", region: "us-east-1", status: "verified" },
        { teamId: otherTeam, name: "other.invalid", region: "us-east-1", status: "verified" },
      ])
      .returning();
    for (const id of [teamId, otherTeam])
      await db.insert(schema.mailboxSubscriptions).values({
        teamId: id,
        status: "active",
        seats: 5,
        storageBytesPerMailbox: 5 * 1024 * 1024,
        includedOutboundPerMailbox: 100,
        periodStart: new Date(Date.now() - 86400000),
        periodEnd: new Date(Date.now() + 86400000),
      });
    mailboxId = (
      await createMailboxRegistry(db, actor(), {
        domainId: domain!.id,
        localPart: "owner",
        label: "Owner",
        kind: "person",
        ownerUserId: "owner",
      })
    ).id;
    otherBox = (
      await createMailboxRegistry(
        db,
        { teamId: otherTeam, userId: "outsider" },
        {
          domainId: other!.id,
          localPart: "other",
          label: "Other",
          kind: "person",
          ownerUserId: "outsider",
        },
      )
    ).id;
  });
  afterEach(() => close());

  it("indexes new mail and finds it by subject prefix, sender, body word and attachment", async () => {
    const proposal = await imported(
      "Proposta para o piloto",
      "Segue o contrato revisado.",
      "s:1",
      "X-Attachment: contrato-final.pdf\r\n",
    );
    const invoice = await imported("Nota fiscal de outubro", "Valor total da cobrança.", "s:2");
    expect(await sweep()).toEqual({ indexed: 2, quarantined: 0, unreadable: 0, remaining: false });
    // Nothing changed: the next sweep has nothing to do.
    expect((await sweep()).indexed).toBe(0);
    const ids = async (query: string, options?: Parameters<typeof search>[1]) =>
      (await search(query, options)).map((row) => row.id);
    expect(await ids("propo")).toEqual([proposal.id]);
    expect(await ids("de:ana")).toEqual([invoice.id, proposal.id]);
    expect(await ids("cobranca")).toEqual([invoice.id]);
    // Body words are whole words: "cobr" is not one.
    expect(await ids("cobr")).toEqual([]);
    expect(await ids("tem:anexo")).toEqual([proposal.id]);
    expect(await ids("contrato final")).toEqual([proposal.id]);
    expect(await ids("assunto:fiscal")).toEqual([invoice.id]);
    expect(await ids("para:ana")).toEqual([]);
    // The rows carry the listing's metadata and order key.
    const [row] = await search("nota");
    expect(row).toMatchObject({ id: invoice.id, mailboxId, kind: "inbox", revision: 1 });
    expect(row?.orderAt).toMatch(/^\d+$/);
  });

  it("pages newest first by position and keeps folders, other mailboxes and teams apart", async () => {
    const first = await imported("Relatório semanal 1", "corpo", "p:1");
    const second = await imported("Relatório semanal 2", "corpo", "p:2");
    const third = await imported("Relatório semanal 3", "corpo", "p:3");
    await importMailboxMime(
      db,
      keys,
      { teamId: otherTeam, userId: "outsider" },
      {
        mailboxId: otherBox,
        sourceId: "o:1",
        raw: message("Relatório semanal", "corpo"),
      },
    );
    await sweep();
    const page = await search("relatorio", { limit: 2 });
    expect(page.map((row) => row.id)).toEqual([third.id, second.id]);
    const rest = await search("relatorio", {
      limit: 2,
      position: { at: page[1]!.orderAt, id: page[1]!.id },
    });
    expect(rest.map((row) => row.id)).toEqual([first.id]);
    // The other team's mailbox is out of reach even when named, and its tokens differ.
    expect(
      (await search("relatorio", { boxes: [mailboxId, otherBox] })).map((r) => r.id),
    ).toHaveLength(3);
    expect(await search("relatorio", { team: otherTeam, boxes: [mailboxId] })).toEqual([]);
    await setMailboxItemTrash(db, actor(), {
      mailboxId,
      id: first.id,
      expectedRevision: 1,
      trashed: true,
    });
    expect((await search("relatorio")).map((r) => r.id)).toEqual([third.id, second.id]);
    expect((await search("relatorio", { folder: "trash" })).map((r) => r.id)).toEqual([first.id]);
  });

  it("reindexes new content only: a saved draft yes, a star no", async () => {
    const draft = await saveMailboxDraft(db, keys, actor(), {
      mailboxId,
      expectedRevision: 0,
      raw: message("Rascunho antigo", "texto"),
    });
    const inbox = await imported("Mensagem", "texto", "r:1");
    await sweep();
    await setMailboxItemStar(db, actor(), {
      mailboxId,
      id: inbox.id,
      expectedRevision: 1,
      starred: true,
    });
    expect((await sweep()).indexed).toBe(0);
    await saveMailboxDraft(db, keys, actor(), {
      mailboxId,
      id: draft.id,
      expectedRevision: 1,
      raw: message("Rascunho novo", "texto"),
    });
    expect((await sweep()).indexed).toBe(1);
    expect((await search("antigo")).map((r) => r.id)).toEqual([]);
    expect((await search("novo", { folder: "drafts" })).map((r) => r.id)).toEqual([draft.id]);
    expect((await search("mensagem", { folder: "favorites" })).map((r) => r.id)).toEqual([
      inbox.id,
    ]);
  });

  it("keeps quarantined mail out until it is released, and records unreadable mail once", async () => {
    const held = await imported("Suspeito", "conteudo perigoso", "q:1");
    const assessment = (decision: "quarantine" | "inbox") => ({
      version: 1 as const,
      decision,
      verdicts: {
        virus: decision === "quarantine" ? "FAIL" : "PASS",
        spam: "PASS",
        spf: "PASS",
        dkim: "PASS",
        dmarc: "PASS",
      },
      dmarcPolicy: "none",
      reasons: decision === "quarantine" ? ["virus"] : [],
    });
    await db
      .update(schema.mailboxItems)
      .set({ deliveryFolder: "quarantine", inboundAssessment: assessment("quarantine") as never })
      .where(eq(schema.mailboxItems.id, held.id));
    expect(await sweep()).toMatchObject({ indexed: 0, quarantined: 1 });
    expect(await search("perigoso")).toEqual([]);
    const [row] = await db
      .select({
        tokens: schema.mailboxSearchIndex.tokens,
        quarantined: schema.mailboxSearchIndex.quarantined,
      })
      .from(schema.mailboxSearchIndex)
      .where(eq(schema.mailboxSearchIndex.itemId, held.id));
    expect(row).toEqual({ tokens: [], quarantined: true });
    await db
      .update(schema.mailboxItems)
      .set({ deliveryFolder: "inbox", inboundAssessment: assessment("inbox") as never })
      .where(eq(schema.mailboxItems.id, held.id));
    expect(await sweep()).toMatchObject({ indexed: 1 });
    expect((await search("perigoso")).map((r) => r.id)).toEqual([held.id]);

    const broken = await imported("Quebrado", "x", "u:1");
    await db
      .update(schema.mailboxItems)
      .set({ wrappedDek: randomBytes(60) })
      .where(eq(schema.mailboxItems.id, broken.id));
    expect(await sweep()).toMatchObject({ unreadable: 1 });
    expect(await sweep()).toMatchObject({ unreadable: 0, indexed: 0 });
  });

  it("drops the index row with its message", async () => {
    const gone = await imported("Apagar", "texto", "d:1");
    await sweep();
    await db.delete(schema.mailboxItems).where(eq(schema.mailboxItems.id, gone.id));
    expect(await db.select().from(schema.mailboxSearchIndex)).toEqual([]);
  });
});
