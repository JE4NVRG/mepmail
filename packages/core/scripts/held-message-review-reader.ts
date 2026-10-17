/** Trusted manual reader. It is never imported by the application or exposed as an API. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { z } from "zod";
import { createKeyringFromEnv } from "../../ses/src/kms.js";
import { decryptEmailBody } from "../src/crypto/envelope.js";
import { renderHeldMessageReview } from "../src/held-message-review-render.js";

const PRODUCTION = "1f1b1d86b79235b21b1659bce5406c192448d269";
const BUILD = "B0p3pV58Z7_b0JFw1m7T3";
// The offline bundler pins these literals to one qualified runtime. Neither the
// request, manifest nor environment may select a different reader audience.
const AUDIENCE = "held-message-review-staging";
const ORIGIN = "http://127.0.0.1:3186";
const readerPinsSchema = z.discriminatedUnion("audience", [
  z
    .object({
      audience: z.literal("held-message-review-staging"),
      origin: z.literal("http://127.0.0.1:3186"),
      productionRevision: z.string().regex(/^[a-f0-9]{40}$/),
      productionBuildId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      audience: z.literal("held-message-review-production"),
      origin: z.literal("https://mepmail.dev"),
      productionRevision: z.string().regex(/^[a-f0-9]{40}$/),
      productionBuildId: z.string().min(1).max(200),
    })
    .strict(),
]);
type ReaderPins = z.infer<typeof readerPinsSchema>;
const READER_PINS: ReaderPins = readerPinsSchema.parse({
  audience: AUDIENCE,
  origin: ORIGIN,
  productionRevision: PRODUCTION,
  productionBuildId: BUILD,
});
const metadata = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  teamId: z.uuid(),
  emailId: z.uuid(),
  operatorId: z.string().min(1).max(200),
  audience: z.enum(["held-message-review-staging", "held-message-review-production"]),
  origin: z.string().url(),
  stagingRevision: z.string().regex(/^[a-f0-9]{40}$/),
  productionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  productionBuildId: z.string().min(1).max(200),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
  holdAt: z.iso.datetime(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
const manifestSchema = metadata.omit({ operationId: true, holdAt: true, issuedAt: true }).strict();
const requestSchema = metadata
  .extend({
    reason: z.enum(["payment_risk_review", "phishing_or_malware", "provider_report"]),
    justification: z.string().min(20).max(1000),
  })
  .strict();
type Metadata = z.infer<typeof metadata>;
type Manifest = z.infer<typeof manifestSchema>;
type RequestData = z.infer<typeof requestSchema>;
type Row = Record<string, unknown>;
interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  end(options: { timeout: number }): Promise<void>;
}

function deny(): never {
  throw new Error("held_review_refused");
}

function pinnedManifest(raw: unknown, rawPins: ReaderPins): Manifest {
  const pins = readerPinsSchema.parse(rawPins);
  const manifest = manifestSchema.parse(raw);
  if (
    Object.entries(pins).some(([key, value]) => manifest[key as keyof Manifest] !== value) ||
    (pins.audience === "held-message-review-production" &&
      manifest.stagingRevision !== pins.productionRevision)
  )
    deny();
  return manifest;
}

/** Pure guard: actual preparation always uses the bundle's frozen READER_PINS. */
export function validateHeldReviewRuntime(
  rawManifest: unknown,
  runtimeRevision: unknown,
  runtimeBuildId: string,
  environment: Record<string, string | undefined>,
  pins: ReaderPins = READER_PINS,
): Manifest {
  const manifest = pinnedManifest(rawManifest, pins);
  if (runtimeRevision !== pins.productionRevision || runtimeBuildId !== pins.productionBuildId)
    deny();
  if (pins.audience === "held-message-review-production") {
    if (
      environment.MEPMAIL_HELD_REVIEW_MODE !== "production" ||
      environment.NODE_ENV !== "production" ||
      !["", "0", "false", "off"].includes(environment.MEPMAIL_LOCAL_PREVIEW ?? "") ||
      !["https://mepmail.dev", "https://mepmail.dev/"].includes(environment.APP_BASE_URL ?? "") ||
      environment.MILLIONSEND_REVISION !== pins.productionRevision ||
      environment.CONTENT_REVEAL !== "off" ||
      environment.SUPPORT_VIEW !== "off"
    )
      deny();
  } else if (environment.MEPMAIL_HELD_REVIEW_MODE === "production") {
    // A previous staging helper cannot serve production reviews.
    deny();
  }
  return manifest;
}

/** Pure contract used by the reader and its synthetic guard tests. */
export function validateHeldReviewRequest(
  raw: unknown,
  rawManifest: unknown,
  operationId: string,
  clock: Date,
  pins: ReaderPins = READER_PINS,
): RequestData {
  const m = pinnedManifest(rawManifest, pins);
  const request = requestSchema.parse(raw);
  if (!z.uuid().safeParse(operationId).success || request.operationId !== operationId) deny();
  for (const [key, value] of Object.entries(m)) {
    if (key !== "expiresAt" && request[key as keyof RequestData] !== value) deny();
  }
  const issued = Date.parse(request.issuedAt),
    expires = Date.parse(request.expiresAt);
  const manifestExpiry = Date.parse(m.expiresAt),
    now = clock.getTime();
  if (
    manifestExpiry <= now ||
    manifestExpiry - now > 6 * 60 * 60_000 ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 30 * 60_000 ||
    expires > manifestExpiry
  )
    deny();
  return request;
}

function payloadMetadata(request: RequestData): Metadata {
  const { reason: _reason, justification: _justification, ...result } = request;
  return result;
}

/** A failed or uncommitted audit can never produce a payload. */
export async function auditedHeldReviewRead<T>(
  startAudit: () => Promise<void>,
  readAndCommit: () => Promise<T>,
): Promise<T> {
  await startAudit();
  return readAndCommit();
}

async function requestRow(tx: Sql, manifest: Manifest, operationId: string) {
  const [identity] = await tx`select current_database() as db,current_user as usr`;
  const [operator] = await tx`select id from "user" order by created_at,id limit 1`;
  if (
    identity?.db !== "millionsend" ||
    identity?.usr !== "millionsend" ||
    operator?.id !== manifest.operatorId
  )
    deny();
  const [row] = await tx`select data from audit_log where id=${operationId} and team_id is null
    and actor_id=${`user:${manifest.operatorId}`} and action='console.held_message_review_requested'
    and target=${`email:${manifest.emailId}`}`;
  const request = validateHeldReviewRequest(row?.data, manifest, operationId, new Date());
  const [team] = await tx`select send_review_at from teams where id=${manifest.teamId} for share`;
  const [email] =
    await tx`select latest_status,body_purged_at,body_ciphertext is not null as body_present
    from emails where id=${manifest.emailId} and team_id=${manifest.teamId} for share`;
  if (
    !(team?.send_review_at instanceof Date) ||
    team.send_review_at.toISOString() !== request.holdAt ||
    !email ||
    !["queued", "queued_quota"].includes(String(email.latest_status)) ||
    email.body_purged_at !== null ||
    email.body_present !== true
  )
    deny();
  return request;
}

export async function privateAudit(tx: Sql, request: RequestData, action: string, data: object) {
  await tx`insert into audit_log(team_id,actor_id,action,target,data)
    values(null,${`user:${request.operatorId}`},${action},${`email:${request.emailId}`},${JSON.stringify(data)}::text::jsonb)`;
}

/** Only the existing production runtime's local keyring sees ciphertext and secrets. */
export async function prepareHeldReview(
  rawManifest: unknown,
  operationId: string,
): Promise<Buffer> {
  const manifest = pinnedManifest(rawManifest, READER_PINS);
  if (!z.uuid().safeParse(operationId).success) deny();
  const response = await fetch("http://127.0.0.1:3000/api/version", {
    signal: AbortSignal.timeout(5_000),
  });
  const version: unknown = await response.json();
  if (!response.ok || !version || typeof version !== "object" || !("revision" in version)) deny();
  // Guard before opening a DB connection, querying ciphertext or constructing keys.
  const environment = process.env;
  validateHeldReviewRuntime(
    manifest,
    version.revision,
    (await readFile("/app/apps/web/.next-cv0-ad8b5f0a/BUILD_ID", "utf8")).trim(),
    environment,
  );
  const runtimeRequire = createRequire("/app/packages/db/package.json");
  const connect = runtimeRequire("postgres") as (url: string, options: object) => Sql;
  // This manual operation is never a cached Turbo task; secrets stay in this runtime.
  if (!environment.DATABASE_URL) deny();
  const sql = connect(environment.DATABASE_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 8,
    idle_timeout: 3,
    connection: {
      application_name: "mepmail-held-review-audited-reader",
      statement_timeout: "10000",
      lock_timeout: "2000",
    },
  });
  let prepared: Buffer | undefined;
  try {
    prepared = await auditedHeldReviewRead(
      () =>
        sql.begin(async (tx) => {
          const request = await requestRow(tx, manifest, operationId);
          await privateAudit(
            tx,
            request,
            "console.held_message_review_started",
            payloadMetadata(request),
          );
        }),
      () =>
        sql.begin(async (tx) => {
          // Serialize just this review; no app/package-wide lock or queue side effect.
          const [lock] =
            await tx`select pg_try_advisory_xact_lock(hashtext(${`held-review:${operationId}`})) as acquired`;
          if (lock?.acquired !== true) deny();
          const request = await requestRow(tx, manifest, operationId);
          const [prior] = await tx`select id from audit_log where team_id is null
          and action='console.held_message_review_prepared' and data->>'operationId'=${operationId} limit 1`;
          if (prior) deny();
          const [row] =
            await tx`select subject,body_ciphertext,body_iv,body_wrapped_dek,body_key_version
          from emails where id=${manifest.emailId} and team_id=${manifest.teamId}`;
          const encrypted = z
            .object({
              subject: z.string(),
              body_ciphertext: z.instanceof(Buffer),
              body_iv: z.instanceof(Buffer),
              body_wrapped_dek: z.instanceof(Buffer),
              body_key_version: z.number().int(),
            })
            .parse(row);
          const keyring = createKeyringFromEnv({
            IS_CLOUD: ["1", "true"].includes(environment.IS_CLOUD ?? ""),
            MASTER_ENCRYPTION_KEY: environment.MASTER_ENCRYPTION_KEY,
            KMS_KEY_ID: environment.KMS_KEY_ID,
            AWS_REGION: environment.AWS_REGION ?? "us-east-1",
            AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY,
          });
          const body = await decryptEmailBody(
            {
              ciphertext: encrypted.body_ciphertext,
              iv: encrypted.body_iv,
              wrappedDek: encrypted.body_wrapped_dek,
              keyVersion: encrypted.body_key_version,
            },
            keyring,
            { teamId: manifest.teamId, rowId: manifest.emailId },
          );
          const rendered = renderHeldMessageReview(encrypted.subject, body);
          // Clear references before any transport. Keys are scrubbed by the existing decryptor.
          body.html = null;
          body.text = null;
          validateHeldReviewRequest(request, manifest, operationId, new Date());
          const meta = payloadMetadata(request);
          const payload = Buffer.from(JSON.stringify({ ...meta, ...rendered }), "utf8");
          if (payload.length > 256 * 1024) deny();
          const payloadSha256 = createHash("sha256").update(payload).digest("hex");
          await privateAudit(tx, request, "console.held_message_review_prepared", {
            ...meta,
            payloadSha256,
          });
          // postgres resolves begin only after COMMIT; a failed commit never reaches stdout.
          return payload;
        }),
    );
  } finally {
    await sql.end({ timeout: 3 });
  }
  if (!prepared) deny();
  const committed = metadata.passthrough().parse(JSON.parse(prepared.toString("utf8")));
  if (Date.parse(committed.expiresAt) <= Date.now()) {
    prepared.fill(0);
    deny();
  }
  return prepared;
}
