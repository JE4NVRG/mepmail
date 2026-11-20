import { createHash } from "node:crypto";
import {
  assertMailboxOutboxSendAccess,
  authorizeGraduatedExternalSender,
  getGraduatedSenderReputation,
  getGraduatedSendingContext,
  getTenantReputation,
  graduatedSendingEnabled,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  parseSingleSender,
  stripMailboxPrivateHeaders,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import type { AbuseJudge } from "../../../packages/core/src/abuse-judge/types.js";
import { guardColdOutreach } from "../../../packages/core/src/outreach-guard.js";
import {
  type DispatchContentSnapshot,
  qualifyDispatchContent,
} from "../../../packages/core/src/pre-dispatch-content.js";
import { judgeForEmail } from "./abuse-judge/index.js";
import { mailboxCorrespondenceCampaign } from "./mailbox-correspondence.js";

type Input = Parameters<MailboxOutboxSender["send"]>[0];
interface Approval {
  active: boolean;
  graduatedEligible: boolean;
  root: Input;
  original: string;
  wire: string;
}
// No persisted/serializable approval, global content cache or cross-attempt reuse.
const approvals = new WeakMap<Input, Approval>();
function fingerprint(input: Input, raw = input.raw): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        teamId: input.teamId,
        mailboxId: input.mailboxId,
        outboxId: input.outboxId,
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        from: input.from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        raw: raw.toString("base64"),
      }),
    )
    .digest("hex");
}
function valid(input: Input, proof: Approval): boolean {
  const hash = fingerprint(input);
  return (
    proof.active &&
    fingerprint(proof.root) === proof.original &&
    (hash === proof.original || hash === proof.wire)
  );
}
function held(): never {
  throw new MailboxSendDeferredError("semantic_content_review");
}

/** Trusted router copies only; spreading/serializing an input does not carry approval. */
export function copyMailboxDispatchInput(input: Input, wire = false): Input {
  const proof = approvals.get(input);
  if (proof && !valid(input, proof)) held();
  const copy = {
    ...input,
    raw: wire ? stripMailboxPrivateHeaders(Buffer.from(input.raw)) : Buffer.from(input.raw),
    to: [...input.to],
    cc: [...input.cc],
    bcc: [...input.bcc],
  };
  if (proof) approvals.set(copy, proof);
  return copy;
}

export function mailboxGraduatedEligible(input: Input): boolean {
  const approval = approvals.get(input);
  return !!approval && valid(input, approval) && approval.graduatedEligible;
}

/** Synchronous last-boundary check: call before irreversible claim AND provider invocation. */
export function assertMailboxDispatchContent(input: Input, raw: Buffer, isCloud?: boolean): void {
  if (isCloud === false) return;
  const proof = approvals.get(input);
  if (!proof || !valid(input, proof) || fingerprint(input, raw) !== proof.wire) held();
}

// Recognize a small, lossless MIME language rather than trusting a parser's merged
// alternatives or rebuilding legacy mail. Unknown/nested/attachment MIME holds.
function mimeParts(raw: Buffer): Buffer[] {
  const value = raw.toString("latin1");
  const end = value.indexOf("\r\n\r\n");
  if (end < 0 || /(^|[^\r])\n/.test(value.slice(0, end))) held();
  const lines = value
    .slice(0, end)
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n");
  if (lines.some((line) => !/^[!-9;-~]+:[^\r\n]*$/.test(line))) held();
  const headers = (key: string) =>
    lines
      .filter((line) => line.slice(0, line.indexOf(":")).toLowerCase() === key)
      .map((line) => line.slice(line.indexOf(":") + 1).trim());
  if (
    ["content-type", "content-transfer-encoding", "content-disposition"].some(
      (key) => headers(key).length > 1,
    )
  )
    held();
  if (headers("content-disposition").length) held();
  const type = headers("content-type")[0] ?? "text/plain";
  if (
    /^text\/(?:plain|html)(?:\s*;\s*charset\s*=\s*(?:"(?:utf-8|us-ascii)"|utf-8|us-ascii))?\s*$/i.test(
      type,
    )
  ) {
    if (
      headers("content-transfer-encoding").some(
        (v) => !/^(?:7bit|8bit|quoted-printable|base64)$/i.test(v),
      )
    )
      held();
    const encoding = (headers("content-transfer-encoding")[0] ?? "7bit").toLowerCase();
    const body = value.slice(end + 4);
    if (encoding === "base64") {
      const encoded = body.replace(/\r\n/g, "");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
        Buffer.from(encoded, "base64").toString("base64") !== encoded
      )
        held();
    } else if (encoding === "quoted-printable") {
      if (/=(?![0-9a-f]{2}|\r\n)/i.test(body)) held();
    } else if (encoding === "7bit" && [...body].some((c) => c.charCodeAt(0) > 127)) held();
    return [raw];
  }
  const match =
    /^multipart\/alternative\s*;\s*boundary\s*=\s*(?:"([A-Za-z0-9'()+_,./:=? -]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))\s*$/i.exec(
      type,
    );
  if (!match || headers("content-transfer-encoding").length) held();
  const boundary = match[1] ?? match[2]!;
  const body = value.slice(end + 4);
  const chunks = body.split(`--${boundary}`);
  if (chunks.length !== 4 || chunks[0]!.trim() || !/^--(?:\r\n)?$/.test(chunks[3]!)) held();
  return chunks.slice(1, 3).map((chunk) => {
    if (!chunk.startsWith("\r\n") || !chunk.endsWith("\r\n")) held();
    const part = Buffer.from(chunk.slice(2, -2), "latin1");
    if (mimeParts(part).length !== 1) held();
    return part;
  });
}
function validateEncodedIdentity(line: string): void {
  const word = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
  const rest = line.replace(word, (_whole, charset: string, encoding: string, payload: string) => {
    if (
      !/^(?:utf-8|us-ascii)$/i.test(charset) ||
      !payload ||
      [...payload].some((c) => c.charCodeAt(0) > 127)
    )
      held();
    let decoded: Buffer;
    if (encoding.toLowerCase() === "b") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) held();
      decoded = Buffer.from(payload, "base64");
      if (decoded.toString("base64") !== payload) held();
    } else {
      if (/=(?![0-9a-f]{2})/i.test(payload)) held();
      decoded = Buffer.from(
        payload
          .replace(/_/g, " ")
          .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          ),
        "latin1",
      );
    }
    if (charset.toLowerCase() === "us-ascii" && decoded.some((b) => b > 127)) held();
    new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    return "";
  });
  if (rest.includes("=?")) held();
}
async function inspect(raw: Buffer) {
  const parts = mimeParts(raw);
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipHtmlToText: true,
  });
  for (const h of parsed.headerLines) {
    if (["from", "reply-to", "subject"].includes(h.key)) validateEncodedIdentity(h.line);
  }
  if (
    parsed.attachments.length ||
    parsed.headerLines.some((h) => h.key === "sender" || h.key.startsWith("resent-"))
  )
    held();
  for (const name of ["from", "to", "cc", "bcc", "reply-to", "subject"])
    if (parsed.headerLines.filter((h) => h.key === name).length > 1) held();
  if (parsed.from?.value.length !== 1 || !parsed.from.value[0]?.address) held();
  if (
    parsed.replyTo &&
    (!parsed.replyTo.value.length ||
      parsed.replyTo.value.some((v) => !v.address || !parseSingleSender(v.address)))
  )
    held();
  // Reject undecodable/unsupported identity instead of silently dropping display names/groups.
  if (
    [parsed.from.text, parsed.replyTo?.text ?? "", parsed.subject ?? ""].some(
      (v) => v.includes("\ufffd") || v.includes("=?"),
    )
  )
    held();
  let text: string | null = null,
    html: string | null = null;
  for (const part of parts) {
    const p = await simpleParser(part, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipHtmlToText: true,
    });
    if (p.attachments.length) held();
    if (
      (p.text ?? "").includes("\ufffd") ||
      (typeof p.html === "string" && p.html.includes("\ufffd"))
    )
      held();
    if (typeof p.html === "string") {
      if (html !== null) held();
      html = p.html;
    } else {
      if (text !== null || p.text === undefined) held();
      text = p.text;
    }
  }
  return { parsed, text, html };
}

export async function withMailboxDispatchContent<T>(
  db: Db,
  input: Input,
  judge: AbuseJudge | null | undefined,
  isCloud: boolean | undefined,
  send: () => Promise<T>,
): Promise<T> {
  if (isCloud === false) return send(); // Only an explicit OSS selection exempts.
  const existing = approvals.get(input);
  if (existing) {
    if (!valid(input, existing)) held();
    return send();
  }
  const original = fingerprint(input);
  let wire: Buffer;
  try {
    wire = stripMailboxPrivateHeaders(Buffer.from(input.raw));
    const [source, final] = await Promise.all([inspect(input.raw), inspect(wire)]);
    if (source.parsed.from!.value[0]!.address!.toLowerCase() !== input.from.toLowerCase()) held();
    const [team] = await db
      .select({
        name: schema.teams.name,
        plan: schema.teams.plan,
        createdAt: schema.teams.createdAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (!team) held();
    const domains = await db
      .select({ name: schema.domains.name })
      .from(schema.domains)
      .where(and(eq(schema.domains.teamId, input.teamId), eq(schema.domains.status, "verified")));
    const snapshot: DispatchContentSnapshot = {
      teamId: input.teamId,
      emailId: input.outboxId,
      from: source.parsed.from!.text,
      to: [...input.to],
      cc: [...input.cc],
      bcc: [...input.bcc],
      replyTo: source.parsed.replyTo ? [source.parsed.replyTo.text] : null,
      subject: source.parsed.subject ?? "",
      sourceHtml: source.html,
      sourceText: source.text,
      html: final.html,
      text: final.text,
      headers: Object.fromEntries(final.parsed.headerLines.map((h) => [h.key, h.line])),
      attachments: false,
      mime: wire,
    };
    if (graduatedSendingEnabled()) {
      const [box] = await db
        .select({
          origin: schema.mailboxes.origin,
          domainId: schema.mailboxes.domainId,
          address: schema.mailboxes.address,
        })
        .from(schema.mailboxes)
        .where(
          and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, input.teamId)),
        );
      if (!box || (box.origin !== "external" && !box.domainId) || box.address !== input.from)
        held();
      await assertMailboxOutboxSendAccess(db, input, "content_preflight");
      const context = await getGraduatedSendingContext(
        box.origin === "external" ? { purpose: "judge" } : {},
      );
      const [row] = await db
        .select()
        .from(schema.mailboxOutbox)
        .where(
          and(
            eq(schema.mailboxOutbox.id, input.outboxId),
            eq(schema.mailboxOutbox.teamId, input.teamId),
            eq(schema.mailboxOutbox.mailboxId, input.mailboxId),
            eq(schema.mailboxOutbox.attemptId, input.attemptId),
            eq(schema.mailboxOutbox.status, "sending"),
          ),
        );
      if (!row) held();
      const reputation =
        box.origin === "external"
          ? await getGraduatedSenderReputation(
              db,
              await authorizeGraduatedExternalSender(
                db,
                {
                  teamId: input.teamId,
                  actorUserId: row.approvedBy,
                  from: input.from,
                  mailboxId: input.mailboxId,
                },
                context,
              ),
              context,
            )
          : await getTenantReputation(db, input.teamId, { ...context, domainId: box.domainId! });
      if (
        !reputation.capacityAvailable ||
        reputation.state === "suspended" ||
        reputation.reason === "review_required"
      )
        held();
      const campaign = mailboxCorrespondenceCampaign({
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: source.parsed.subject,
        html: final.html,
        text: final.text,
        headers: Object.fromEntries(final.parsed.headerLines.map((h) => [h.key, h.line])),
      });
      if (campaign && !reputation.campaignEligible) held();
    }
    const decision = await qualifyDispatchContent(
      snapshot,
      {
        name: team.name,
        plan: team.plan,
        ageDays: Math.floor((Date.now() - team.createdAt.getTime()) / 86_400_000),
        verifiedDomains: domains.map((d) => d.name),
      },
      judge && graduatedSendingEnabled()
        ? judgeForEmail(judge, db, input.teamId, input.outboxId, "mailbox")
        : judge,
    );
    if (!decision.allowed || fingerprint(input) !== original) held();
  } catch {
    held();
  }
  // Cold outreach is refused before any judge call: the risk is sending,
  // not the verdict latency. A hold is the safe outcome.
  if (
    guardColdOutreach({
      from: (input as { from?: string }).from ?? "",
      subject: (input as { subject?: string }).subject ?? "",
    }).blocked
  ) {
    held();
  }
  const proof: Approval = {
    active: true,
    graduatedEligible: graduatedSendingEnabled(),
    root: input,
    original,
    wire: fingerprint(input, wire),
  };
  approvals.set(input, proof);
  try {
    // This check is before any physical adapter invocation. A revoked grant or
    // unavailable authority read is a known safe deferral, not ambiguous SMTP.
    try {
      // Only this post-judge caller may renew a provably expired admission
      // envelope inside the same private attempt; pre-model and relay stay closed.
      await assertMailboxOutboxSendAccess(db, input, "content_preflight", true);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
      throw new MailboxSendDeferredError(
        code === "forbidden" || code === "not_found" ? "review_required" : "preflight_unavailable",
      );
    }
    return await send();
  } finally {
    proof.active = false;
    approvals.delete(input);
  }
}
