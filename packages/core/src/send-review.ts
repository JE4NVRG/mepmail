import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { parseMailbox } from "./sender-address.js";

/**
 * Pre-send protection, ahead of SES: what a phishing run looks like before
 * the first complaint arrives. Two screens, cloud only:
 *
 * - A disguised sender name or subject is refused outright: one word mixing
 *   alphabets ("Ваnсо" — Cyrillic В а с о around a Latin n), a word spelled
 *   wholly in look-alike Cyrillic or Greek letters beside Latin words
 *   ("Banco СТТ"), or invisible and direction-override characters in the name.
 *   No legitimate sender needs any of these.
 * - A young team whose sender name or subject reads as a bank, a carrier, a
 *   tax office or an account-security notice is held for review: its mail is
 *   accepted and parked, and an operator releases it (it then drains) or
 *   suspends the team (it never leaves). A released team is not held again by
 *   this screen.
 *
 * A third hold comes from billing: a team whose card Stripe's fraud screening
 * blocked (see holdTeamForReview's "payment_risk").
 */

/** Teams younger than this are screened for impersonation. */
export const SEND_REVIEW_NEW_TEAM_DAYS = 30;

export type SendReviewReason = (typeof schema.sendReviewReasonEnum.enumValues)[number];

/** Alphabets with letters that pass for Latin ones; any two in one word is a disguise. */
const LOOKALIKE_SCRIPTS = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["cherokee", /\p{Script=Cherokee}/u],
] as const;
type LookalikeScript = (typeof LOOKALIKE_SCRIPTS)[number][0];

/**
 * Cyrillic and Greek letters drawn like Latin ones, with the Latin letter
 * each passes for. A word made only of these reads as Latin to the eye.
 */
const LATIN_LOOKALIKES: Record<string, string> = {
  // Cyrillic capitals and small letters
  А: "a",
  В: "b",
  С: "c",
  Е: "e",
  Н: "h",
  І: "i",
  Ј: "j",
  К: "k",
  М: "m",
  О: "o",
  Р: "p",
  Ѕ: "s",
  Т: "t",
  Х: "x",
  Ү: "y",
  Ԛ: "q",
  Ԝ: "w",
  Ӏ: "l",
  а: "a",
  с: "c",
  е: "e",
  һ: "h",
  і: "i",
  ј: "j",
  о: "o",
  р: "p",
  ѕ: "s",
  у: "y",
  х: "x",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ӏ: "l",
  // Greek capitals and small letters
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
  ο: "o",
  ι: "i",
  κ: "k",
  ν: "v",
  α: "a",
  ρ: "p",
  υ: "u",
};

/** Zero-width, soft-hyphen and bidi controls: never needed in a sender name. */
const INVISIBLE_IN_NAME = /[­​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
/** Embedding and override controls reorder what the reader sees in a subject. */
const OVERRIDE_IN_SUBJECT = /[‪-‮]/u;
/** Invisible characters that only split or pad a word; ignored when reading words. */
const WORD_PADDING = /[­​‌⁠-⁤﻿]/gu;

function scriptsOf(word: string): Set<LookalikeScript> {
  const found = new Set<LookalikeScript>();
  for (const char of word) {
    for (const [name, pattern] of LOOKALIKE_SCRIPTS) {
      if (pattern.test(char)) {
        found.add(name);
        break;
      }
    }
  }
  return found;
}

function words(text: string): string[] {
  return text.replace(WORD_PADDING, "").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** A Cyrillic or Greek word spelled only in letters that pass for Latin. */
function lookalikeWord(word: string): boolean {
  const letters = [...word].filter((c) => /\p{L}/u.test(c));
  return letters.length >= 2 && letters.every((c) => c in LATIN_LOOKALIKES);
}

/**
 * The first disguised word in `text`, or null. Mixed alphabets inside one
 * word always count; a whole word of look-alikes counts when the rest of the
 * text is Latin and holds no genuine word of that alphabet ("ООО Ромашка LLC"
 * stays legitimate, "Banco СТТ" does not).
 */
export function disguisedWord(text: string): string | null {
  const list = words(text);
  for (const word of list) {
    if (scriptsOf(word).size > 1) return word;
  }
  const hasLatin = list.some((w) => scriptsOf(w).has("latin"));
  if (!hasLatin) return null;
  const foreign = list.filter((w) => {
    const scripts = scriptsOf(w);
    return scripts.size > 0 && !scripts.has("latin");
  });
  if (foreign.length === 0 || !foreign.every(lookalikeWord)) return null;
  return foreign[0] ?? null;
}

export type DisguiseFinding = { field: "from" | "subject"; sample: string };

/** The sender name of a single-mailbox From, or "" when it has none. */
export function senderName(from: string): string {
  return parseMailbox(from)?.name ?? "";
}

/** Refusal grounds for a send, or null: a disguised sender name or subject. */
export function findDisguise(input: { from: string; subject: string }): DisguiseFinding | null {
  const name = senderName(input.from);
  if (INVISIBLE_IN_NAME.test(name)) return { field: "from", sample: "invisible characters" };
  const nameWord = disguisedWord(name);
  if (nameWord) return { field: "from", sample: nameWord };
  if (OVERRIDE_IN_SUBJECT.test(input.subject)) {
    return { field: "subject", sample: "direction override characters" };
  }
  const subjectWord = disguisedWord(input.subject);
  if (subjectWord) return { field: "subject", sample: subjectWord };
  return null;
}

/** Wire message for a disguised send, the same on every surface. */
export function disguiseMessage(finding: DisguiseFinding): string {
  const where = finding.field === "from" ? "from display name" : "subject";
  return `The ${where} mixes look-alike letters from different alphabets or hides characters ("${finding.sample}"), a pattern used to impersonate brands. Write it in one alphabet and send again.`;
}

/**
 * Lowercase, accents and look-alikes folded to plain Latin, punctuation to
 * spaces: "Ação Necessária" → "acao necessaria", "Ваnсо" → "banco".
 */
export function foldText(text: string): string {
  const mapped = [...text.replace(WORD_PADDING, "")].map((c) => LATIN_LOOKALIKES[c] ?? c).join("");
  return mapped
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Names a phishing run borrows, matched as whole words in the sender name:
 * banks and payment brands, carriers and couriers, tax and benefit offices,
 * and the account providers whose logins are stolen most.
 */
const IMPERSONATED_NAMES = [
  // banks and payments
  "banco",
  "bank",
  "banking",
  "itau",
  "bradesco",
  "santander",
  "caixa",
  "nubank",
  "sicredi",
  "sicoob",
  "banrisul",
  "millennium",
  "millenniumbcp",
  "bcp",
  "novobanco",
  "novo banco",
  "cgd",
  "montepio",
  "activobank",
  "credito agricola",
  "revolut",
  "paypal",
  "mercado pago",
  "mercadopago",
  "picpay",
  "pagseguro",
  "pix",
  "serasa",
  "mastercard",
  "american express",
  "amex",
  "binance",
  "coinbase",
  // carriers, couriers and post
  "ctt",
  "correios",
  "vivo",
  "claro",
  "meo",
  "vodafone",
  "nowo",
  "operadora",
  "dhl",
  "fedex",
  "usps",
  "royal mail",
  "chronopost",
  "dpd",
  // tax, benefits and government
  "receita federal",
  "portal das financas",
  "autoridade tributaria",
  "seguranca social",
  "inss",
  "detran",
  "gov br",
  "govbr",
  // account providers
  "apple",
  "icloud",
  "microsoft",
  "outlook",
  "office 365",
  "hotmail",
  "netflix",
  "amazon",
  "google",
  "gmail",
  "facebook",
  "instagram",
  "whatsapp",
  "linkedin",
  "docusign",
  // a security desk
  "seguranca",
  "security",
];

/** The wording of a credential or payment lure, matched in the sender name and the subject. */
const LURE_PHRASES = [
  "seguranca da conta",
  "seguranca de conta",
  "account security",
  "security alert",
  "alerta de seguranca",
  "aviso de seguranca",
  "security notice",
  "verifique sua conta",
  "verifique a sua conta",
  "verify your account",
  "confirme seus dados",
  "confirme os seus dados",
  "confirme os seus contactos",
  "confirme os seus contatos",
  "confirme seus contatos",
  "confirm your details",
  "conta bloqueada",
  "conta suspensa",
  "account suspended",
  "account locked",
  "acesso bloqueado",
  "atualize seus dados",
  "atualize os seus dados",
  "atualizacao cadastral",
  "unusual sign in",
  "unusual activity",
  "atividade incomum",
  "atividade suspeita",
  "suspicious activity",
  "login suspeito",
  "sua senha expira",
  "your password expires",
  "chave pix",
  "encomenda retida",
  "pacote retido",
  "taxa alfandegaria",
  "entrega pendente",
];

function containsPhrase(folded: string, phrase: string): boolean {
  return ` ${folded} `.includes(` ${phrase} `);
}

export type ImpersonationFinding = { field: "from" | "subject"; term: string };

/** What a send's sender name or subject imitates, or null. */
export function findImpersonation(input: {
  from: string;
  subject: string;
}): ImpersonationFinding | null {
  const name = foldText(senderName(input.from));
  const subject = foldText(input.subject);
  for (const term of IMPERSONATED_NAMES) {
    if (name && containsPhrase(name, term)) return { field: "from", term };
  }
  for (const term of LURE_PHRASES) {
    if (name && containsPhrase(name, term)) return { field: "from", term };
    if (containsPhrase(subject, term)) return { field: "subject", term };
  }
  return null;
}

export function impersonationNote(finding: ImpersonationFinding): string {
  return `${finding.field === "from" ? "Sender name" : "Subject"} reads as "${finding.term}"`;
}

/**
 * Hold a team's sending for review: accepted mail parks until an operator
 * releases it. Idempotent — a team already held keeps its first reason. The
 * review flag puts the team on the trust & safety list (unless it already
 * holds an open flag). Runs in the caller's transaction when given one; the
 * audit row and the operator's notice follow from the safety sweep, outside it.
 */
export async function holdTeamForReview(
  db: Db,
  input: { teamId: string; reason: SendReviewReason; note: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const held = await db
    .update(schema.teams)
    .set({
      sendReviewAt: now,
      sendReviewReason: input.reason,
      sendReviewNote: input.note.slice(0, 500),
      sendReviewNotifiedAt: null,
    })
    .where(and(eq(schema.teams.id, input.teamId), isNull(schema.teams.sendReviewAt)))
    .returning({ id: schema.teams.id });
  if (held.length === 0) return false;
  await db
    .insert(schema.teamFlags)
    .values({ teamId: input.teamId, reason: "review", note: input.note.slice(0, 500) })
    .onConflictDoNothing();
  return true;
}

/**
 * Screen a young team's send for impersonation and hold the team when it
 * matches. Reads the team only when the text matches, so the common send pays
 * nothing. Returns whether the team is held after the call.
 */
export async function screenImpersonation(
  db: Db,
  input: { teamId: string; from: string; subject: string; now?: Date },
): Promise<boolean> {
  const finding = findImpersonation(input);
  if (!finding) return false;
  const now = input.now ?? new Date();
  const [team] = await db
    .select({
      plan: schema.teams.plan,
      createdAt: schema.teams.createdAt,
      sendReviewAt: schema.teams.sendReviewAt,
      sendReviewClearedAt: schema.teams.sendReviewClearedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!team || team.plan === "system") return false;
  if (team.sendReviewAt) return true;
  if (team.sendReviewClearedAt) return false;
  const ageMs = now.getTime() - team.createdAt.getTime();
  if (ageMs > SEND_REVIEW_NEW_TEAM_DAYS * 86_400_000) return false;
  await holdTeamForReview(db, {
    teamId: input.teamId,
    reason: "impersonation",
    note: impersonationNote(finding),
    now,
  });
  return true;
}

/** Holds the operator has not heard about yet, oldest first. */
export async function unnotifiedSendReviews(db: Db) {
  return db
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      reason: schema.teams.sendReviewReason,
      note: schema.teams.sendReviewNote,
      at: schema.teams.sendReviewAt,
    })
    .from(schema.teams)
    .where(and(isNotNull(schema.teams.sendReviewAt), isNull(schema.teams.sendReviewNotifiedAt)))
    .orderBy(schema.teams.sendReviewAt)
    .limit(50);
}

/** Marks a hold as told; false when it was released or already marked meanwhile. */
export async function markSendReviewNotified(db: Db, teamId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(schema.teams)
    .set({ sendReviewNotifiedAt: now })
    .where(
      and(
        eq(schema.teams.id, teamId),
        isNotNull(schema.teams.sendReviewAt),
        isNull(schema.teams.sendReviewNotifiedAt),
      ),
    )
    .returning({ id: schema.teams.id });
  return rows.length > 0;
}
