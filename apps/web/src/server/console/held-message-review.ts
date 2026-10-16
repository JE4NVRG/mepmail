import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { posix } from "node:path";
import type { RevealSpan } from "@millionsend/core/content-reveal";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

const AUDIENCE = "held-message-review-staging";
const REQUESTED = "console.held_message_review_requested";
const PREPARED = "console.held_message_review_prepared";
const VIEWED = "console.held_message_review_viewed";
const MAX_BYTES = 256 * 1024;
const TTL = 30 * 60_000;
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime();
const metadata = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  teamId: z.uuid(),
  emailId: z.uuid(),
  operatorId: z.string().min(1).max(200),
  audience: z.literal(AUDIENCE),
  origin: z.string().url(),
  stagingRevision: revision,
  productionRevision: revision,
  productionBuildId: z.string().min(1).max(200),
  helperSha256: digest,
  holdAt: instant,
  issuedAt: instant,
  expiresAt: instant,
});
export const heldReviewManifestSchema = metadata
  .omit({ operationId: true, holdAt: true, issuedAt: true })
  .strict();
export const heldReviewReasonSchema = z.enum([
  "payment_risk_review",
  "phishing_or_malware",
  "provider_report",
]);
export const heldReviewRequestSchema = z.object({
  teamId: z.uuid(),
  emailId: z.uuid(),
  reason: heldReviewReasonSchema,
  justification: z.string().trim().min(20).max(1000),
});
const requestData = metadata
  .extend({ reason: heldReviewReasonSchema, justification: z.string().min(20).max(1000) })
  .strict();
const preparedData = metadata.extend({ payloadSha256: digest }).strict();
const span = z
  .object({ text: z.string().max(20_000), redacted: z.literal(true).optional() })
  .strict();
const payloadSchema = metadata
  .extend({
    subject: z.array(span).max(2000),
    spans: z.array(span).max(2000),
    redactions: z.number().int().min(0).max(4000),
    linkHosts: z
      .array(
        z
          .string()
          .max(253)
          .refine(
            (host) =>
              isIP(host) !== 0 ||
              /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
                host,
              ),
          ),
      )
      .max(30),
  })
  .strict()
  .refine((p) => [...p.subject, ...p.spans].reduce((n, s) => n + s.text.length, 0) <= 20_000)
  .refine((p) => p.redactions === [...p.subject, ...p.spans].filter((s) => s.redacted).length)
  .refine((p) => new Set(p.linkHosts).size === p.linkHosts.length);

type Manifest = z.infer<typeof heldReviewManifestSchema>;
type RequestData = z.infer<typeof requestData>;
type Metadata = z.infer<typeof metadata>;
type ReviewContext = { db: Db; operator: { id: string } };
export interface HeldReviewDependencies {
  env?: () => Record<string, string | undefined>;
  readFile?: (absolutePath: string) => Promise<Buffer>;
  now?: () => Date;
  operationId?: () => string;
}
export interface HeldReviewContent {
  subject: RevealSpan[];
  spans: RevealSpan[];
  expiresAt: Date;
  redactions: number;
  linkHosts: string[];
}

function refuse(
  code: "FORBIDDEN" | "NOT_FOUND" | "PRECONDITION_FAILED" = "PRECONDITION_FAILED",
): never {
  throw new TRPCError({ code, message: "held_review_unavailable" });
}

async function boundedFile(path: string): Promise<Buffer> {
  // The private, read-only mount is configuration, never a request parameter.
  if ((await realpath(posix.dirname(path))) !== posix.dirname(path)) refuse();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) refuse();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_BYTES) refuse();
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function sameMetadata(a: Metadata, b: Metadata): boolean {
  return Object.keys(metadata.shape).every(
    (key) => a[key as keyof Metadata] === b[key as keyof Metadata],
  );
}

async function strictAudit(db: Db, row: typeof schema.auditLog.$inferInsert): Promise<void> {
  try {
    await db.insert(schema.auditLog).values(row);
  } catch {
    // Do not expose the driver's SQL/parameters (including internal justification).
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "held_review_audit_failed" });
  }
}

export function createHeldMessageReviewService(deps: HeldReviewDependencies = {}) {
  const env = deps.env ?? (() => process.env);
  const readFile = deps.readFile ?? boundedFile;
  const now = deps.now ?? (() => new Date());

  async function jsonFile(dir: string, name: string): Promise<unknown> {
    try {
      const bytes = await readFile(posix.join(dir, name));
      if (bytes.length > MAX_BYTES) refuse();
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return refuse();
    }
  }

  async function config() {
    const e = env();
    const dir = e.MEPMAIL_HELD_REVIEW_DIR;
    if (!dir) return null;
    if (
      !["1", "true"].includes(e.MEPMAIL_LOCAL_PREVIEW ?? "") ||
      !["1", "true"].includes(e.BILLING_MUTATIONS_PAUSED ?? "") ||
      e.MAILBOX_TRANSPORT_ENABLED === "1" ||
      !posix.isAbsolute(dir) ||
      dir === "/" ||
      posix.normalize(dir) !== dir
    )
      return null;
    let origin: string;
    try {
      const u = new URL(e.APP_BASE_URL ?? "");
      if (
        u.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        return null;
      origin = u.origin;
    } catch {
      return null;
    }
    const result = heldReviewManifestSchema.safeParse(await jsonFile(dir, "manifest.json"));
    if (!result.success) refuse();
    const manifest = result.data;
    const remaining = Date.parse(manifest.expiresAt) - now().getTime();
    if (
      manifest.origin !== origin ||
      manifest.stagingRevision !== e.MILLIONSEND_REVISION ||
      remaining <= 0 ||
      remaining > 6 * 60 * 60_000
    )
      refuse();
    return { dir, manifest };
  }

  function scope(ctx: ReviewContext, manifest: Manifest, teamId: string, emailId?: string) {
    if (manifest.operatorId !== ctx.operator.id) refuse("FORBIDDEN");
    if (manifest.teamId !== teamId || (emailId !== undefined && manifest.emailId !== emailId))
      refuse("NOT_FOUND");
  }

  async function eligible(db: Db, manifest: Manifest, lock = false) {
    const teamQuery = db
      .select({ holdAt: schema.teams.sendReviewAt })
      .from(schema.teams)
      .where(eq(schema.teams.id, manifest.teamId));
    const [team] = await (lock ? teamQuery.for("update") : teamQuery);
    const e = schema.emails;
    const emailQuery = db
      .select({
        id: e.id,
        status: e.latestStatus,
        createdAt: e.createdAt,
        bodyPresent: sql<boolean>`${e.bodyPurgedAt} is null and ${e.bodyCiphertext} is not null and ${e.bodyIv} is not null and ${e.bodyWrappedDek} is not null and ${e.bodyKeyVersion} is not null`,
      })
      .from(e)
      .where(and(eq(e.id, manifest.emailId), eq(e.teamId, manifest.teamId)));
    const [email] = await (lock ? emailQuery.for("share") : emailQuery);
    if (!team?.holdAt || !email?.bodyPresent || !["queued", "queued_quota"].includes(email.status))
      return null;
    return {
      message: {
        id: email.id,
        status: email.status as "queued" | "queued_quota",
        createdAt: email.createdAt,
      },
      holdAt: team.holdAt.toISOString(),
    };
  }

  function validRequest(value: unknown, manifest: Manifest, holdAt: string) {
    const parsed = requestData.safeParse(value);
    if (!parsed.success) return null;
    const data = parsed.data;
    const { expiresAt: _manifestExpiry, ...manifestMetadata } = manifest;
    if (
      Object.entries(manifestMetadata).some(
        ([key, value]) => data[key as keyof RequestData] !== value,
      ) ||
      data.holdAt !== holdAt
    )
      return null;
    const issued = Date.parse(data.issuedAt);
    const expires = Date.parse(data.expiresAt);
    const clock = now().getTime();
    if (
      issued > clock ||
      expires <= clock ||
      expires <= issued ||
      expires - issued > TTL ||
      expires > Date.parse(manifest.expiresAt)
    )
      return null;
    return data;
  }

  async function access(db: Db, manifest: Manifest, holdAt: string, operationId?: string) {
    const a = schema.auditLog;
    const rows = await db
      .select({ id: a.id, data: a.data })
      .from(a)
      .where(
        and(
          isNull(a.teamId),
          eq(a.actorId, `user:${manifest.operatorId}`),
          eq(a.action, REQUESTED),
          eq(a.target, `email:${manifest.emailId}`),
          operationId ? eq(a.id, operationId) : undefined,
        ),
      )
      .orderBy(desc(a.createdAt), desc(a.id))
      .limit(operationId ? 1 : 20);
    for (const row of rows) {
      const data = validRequest(row.data, manifest, holdAt);
      if (data && data.operationId === row.id) return data;
    }
    return null;
  }

  async function content(db: Db, dir: string, requested: RequestData) {
    const a = schema.auditLog;
    const rows = await db
      .select({ data: a.data })
      .from(a)
      .where(
        and(
          isNull(a.teamId),
          eq(a.actorId, `user:${requested.operatorId}`),
          eq(a.action, PREPARED),
          eq(a.target, `email:${requested.emailId}`),
          sql`${a.data}->>'operationId' = ${requested.operationId}`,
        ),
      )
      .orderBy(desc(a.createdAt))
      .limit(2);
    if (rows.length === 0) return null;
    if (rows.length !== 1) refuse();
    const proof = preparedData.safeParse(rows[0]?.data);
    if (!proof.success || !sameMetadata(proof.data, requested)) refuse();
    let bytes: Buffer;
    try {
      bytes = await readFile(posix.join(dir, `${requested.operationId}.json`));
    } catch {
      return refuse();
    }
    if (
      bytes.length > MAX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== proof.data.payloadSha256
    )
      refuse();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return refuse();
    }
    const payload = payloadSchema.safeParse(value);
    if (!payload.success || !sameMetadata(payload.data, requested)) refuse();
    return { payload: payload.data, payloadSha256: proof.data.payloadSha256 };
  }

  return {
    async status(ctx: ReviewContext, input: { teamId: string }) {
      const cfg = await config();
      if (!cfg) return { enabled: false, message: null, access: null };
      scope(ctx, cfg.manifest, input.teamId);
      const row = await eligible(ctx.db, cfg.manifest);
      if (!row) return { enabled: true, message: null, access: null };
      const requested = await access(ctx.db, cfg.manifest, row.holdAt);
      const ready = requested ? await content(ctx.db, cfg.dir, requested) : null;
      return {
        enabled: true,
        message: row.message,
        access: requested
          ? {
              operationId: requested.operationId,
              expiresAt: new Date(requested.expiresAt),
              state: ready ? ("ready" as const) : ("pending" as const),
            }
          : null,
      };
    },
    async requestAccess(ctx: ReviewContext, input: z.infer<typeof heldReviewRequestSchema>) {
      const cfg = await config();
      if (!cfg) refuse("FORBIDDEN");
      scope(ctx, cfg.manifest, input.teamId, input.emailId);
      const valid = heldReviewRequestSchema.parse(input);
      return ctx.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        const row = await eligible(db, cfg.manifest, true);
        if (!row) refuse();
        const previous = await access(db, cfg.manifest, row.holdAt);
        if (previous)
          return { operationId: previous.operationId, expiresAt: new Date(previous.expiresAt) };
        const issuedAt = now();
        const expiresAt = new Date(
          Math.min(issuedAt.getTime() + TTL, Date.parse(cfg.manifest.expiresAt)),
        );
        if (expiresAt <= issuedAt) refuse();
        const operationId = deps.operationId?.() ?? randomUUID();
        const data = requestData.parse({
          ...cfg.manifest,
          ...valid,
          operationId,
          holdAt: row.holdAt,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });
        await strictAudit(db, {
          id: operationId,
          teamId: null,
          actorId: `user:${ctx.operator.id}`,
          action: REQUESTED,
          target: `email:${input.emailId}`,
          data,
        });
        return { operationId, expiresAt };
      });
    },
    async revealed(
      ctx: ReviewContext,
      input: { teamId: string; emailId: string; operationId: string },
    ): Promise<HeldReviewContent> {
      const cfg = await config();
      if (!cfg) refuse("FORBIDDEN");
      scope(ctx, cfg.manifest, input.teamId, input.emailId);
      if (!z.uuid().safeParse(input.operationId).success) refuse("NOT_FOUND");
      const result = await ctx.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        const row = await eligible(db, cfg.manifest, true);
        if (!row) refuse();
        const requested = await access(db, cfg.manifest, row.holdAt, input.operationId);
        if (!requested) refuse("NOT_FOUND");
        const prepared = await content(db, cfg.dir, requested);
        if (!prepared) refuse();
        // Recheck the clock after filesystem I/O; an expired operation never releases content.
        if (Date.parse(requested.expiresAt) <= now().getTime()) refuse();
        await strictAudit(db, {
          teamId: null,
          actorId: `user:${ctx.operator.id}`,
          action: VIEWED,
          target: `email:${input.emailId}`,
          data: { ...metadata.parse(requested), payloadSha256: prepared.payloadSha256 },
        });
        const { subject, spans, redactions, linkHosts } = prepared.payload;
        const publicSpans = (items: typeof spans): RevealSpan[] =>
          items.map((item) =>
            item.redacted ? { text: item.text, redacted: true } : { text: item.text },
          );
        return {
          subject: publicSpans(subject),
          spans: publicSpans(spans),
          redactions,
          linkHosts,
          expiresAt: new Date(requested.expiresAt),
        };
      });
      // The audit may commit across the deadline. Keep its record, withhold the content.
      if (result.expiresAt.getTime() <= now().getTime()) refuse();
      return result;
    },
  };
}
