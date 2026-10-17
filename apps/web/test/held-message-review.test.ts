import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleHeldMessageReviewRouter } from "@/server/routers/console/held-message-review";
import { type Context, createCallerFactory, router } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;
const OPERATOR = "held-review-operator";
const OTHER = "held-review-other";
const DIR = "/private/held-review";
let teamId: string;
let emailId: string;
let clock: Date;
let env: Record<string, string | undefined>;
let manifest: Record<string, unknown>;
let files: Map<string, Buffer>;
let reads: string[];
let afterPayloadRead: (() => void) | null;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const input = () => ({
  teamId,
  emailId,
  reason: "payment_risk_review" as const,
  justification: "Review the synthetic held message before any decision.",
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    {
      id: OPERATOR,
      name: "Synthetic Operator",
      email: "operator@example.test",
      createdAt: new Date(0),
    },
    { id: OTHER, name: "Synthetic Member", email: "other@example.test", createdAt: new Date(1) },
  ]);
});
afterAll(() => close());
beforeEach(async () => {
  clock = new Date("2026-10-16T22:00:00.000Z");
  teamId = await createTeam(db, `held-${randomUUID()}`);
  emailId = randomUUID();
  await db
    .update(schema.teams)
    .set({ sendReviewAt: new Date("2026-10-14T02:58:02.000Z"), sendReviewReason: "payment_risk" })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.emails).values({
    id: emailId,
    teamId,
    from: "Synthetic <sender@example.test>",
    to: ["recipient@example.test"],
    subject: "Synthetic public fixture",
    latestStatus: "queued_quota",
    createdAt: new Date("2026-10-14T03:00:00.000Z"),
    bodyCiphertext: Buffer.from("synthetic ciphertext"),
    bodyIv: Buffer.from("synthetic iv"),
    bodyWrappedDek: Buffer.from("synthetic wrapped key"),
    bodyKeyVersion: 1,
  });
  env = {
    MEPMAIL_HELD_REVIEW_DIR: DIR,
    MEPMAIL_LOCAL_PREVIEW: "1",
    BILLING_MUTATIONS_PAUSED: "true",
    MAILBOX_TRANSPORT_ENABLED: "0",
    APP_BASE_URL: "http://127.0.0.1:3482",
    MILLIONSEND_REVISION: "a".repeat(40),
    CONTENT_REVEAL: "off",
    SUPPORT_VIEW: "off",
  };
  manifest = {
    schemaVersion: 1,
    audience: "held-message-review-staging",
    origin: env.APP_BASE_URL,
    stagingRevision: "a".repeat(40),
    productionRevision: "b".repeat(40),
    productionBuildId: "public-fixture-build",
    helperSha256: "c".repeat(64),
    teamId,
    emailId,
    operatorId: OPERATOR,
    expiresAt: "2026-10-17T00:00:00.000Z",
  };
  files = new Map();
  reads = [];
  afterPayloadRead = null;
  writeManifest();
});

function writeManifest() {
  files.set(`${DIR}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
}
function productionMode() {
  Object.assign(env, {
    MEPMAIL_HELD_REVIEW_MODE: "production",
    NODE_ENV: "production",
    MEPMAIL_LOCAL_PREVIEW: "0",
    BILLING_MUTATIONS_PAUSED: "0",
    MAILBOX_TRANSPORT_ENABLED: "1",
    APP_BASE_URL: "https://mepmail.dev",
  });
  Object.assign(manifest, {
    audience: "held-message-review-production",
    origin: env.APP_BASE_URL,
    productionRevision: env.MILLIONSEND_REVISION,
  });
  writeManifest();
}
function caller(userId = OPERATOR) {
  const review = createConsoleHeldMessageReviewRouter({
    env: () => env,
    now: () => clock,
    readFile: async (path) => {
      reads.push(path);
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
      if (!path.endsWith("/manifest.json")) afterPayloadRead?.();
      return bytes;
    },
  });
  const ctx: Context = {
    db,
    session: { user: { id: userId, name: userId, email: `${userId}@example.test` } },
    teamId: null,
    role: null,
  };
  return createCallerFactory(router({ review }))(ctx).review;
}
async function rows(action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.target, `email:${emailId}`)));
}
async function prepare(
  operationId: string,
  modify?: (payload: Record<string, unknown>) => void,
  proofModify?: (proof: Record<string, unknown>) => void,
) {
  const [request] = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.id, operationId));
  if (!request?.data) throw new Error("fixture request missing");
  const { reason: _reason, justification: _justification, ...metadata } = request.data;
  const payload = {
    ...metadata,
    subject: [{ text: "Synthetic fixture" }],
    spans: [{ text: "Public example body. " }, { text: "[redacted]", redacted: true }],
    redactions: 1,
    linkHosts: ["example.test"],
  };
  modify?.(payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  files.set(posix.join(DIR, `${operationId}.json`), bytes);
  const proof = { ...metadata, payloadSha256: sha(bytes) };
  proofModify?.(proof);
  await db.insert(schema.auditLog).values({
    teamId: null,
    actorId: `user:${OPERATOR}`,
    action: "console.held_message_review_prepared",
    target: `email:${emailId}`,
    data: proof,
  });
  return bytes;
}

describe("scoped held message review", () => {
  it("denies a non-operator before reading configuration or files", async () => {
    await expect(caller(OTHER).status({ teamId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(reads).toEqual([]);
  });

  it.each([
    ["MEPMAIL_HELD_REVIEW_DIR", undefined],
    ["MEPMAIL_LOCAL_PREVIEW", "0"],
    ["BILLING_MUTATIONS_PAUSED", "0"],
    ["MAILBOX_TRANSPORT_ENABLED", "1"],
    ["APP_BASE_URL", "https://mepmail.dev"],
    ["APP_BASE_URL", "http://127.0.0.1.example.test"],
    ["MEPMAIL_HELD_REVIEW_DIR", "../relative"],
    ["MEPMAIL_HELD_REVIEW_MODE", "unknown"],
    ["CONTENT_REVEAL", "on"],
    ["CONTENT_REVEAL", undefined],
    ["SUPPORT_VIEW", "on"],
    ["SUPPORT_VIEW", undefined],
  ])("disables private mode for unsafe %s=%s", async (key, value) => {
    env[key] = value;
    expect(await caller().status({ teamId })).toEqual({
      enabled: false,
      message: null,
      access: null,
    });
    await expect(caller().requestAccess(input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rows("console.held_message_review_requested")).toHaveLength(0);
  });

  it("keeps the staging defaults and explicit staging mode equivalent", async () => {
    const implicit = await caller().status({ teamId });
    env.MEPMAIL_HELD_REVIEW_MODE = "staging";
    expect(await caller().status({ teamId })).toEqual(implicit);
    expect(implicit.enabled).toBe(true);
  });

  it.each([
    ["NODE_ENV", "development"],
    ["NODE_ENV", undefined],
    ["MEPMAIL_LOCAL_PREVIEW", "1"],
    ["MEPMAIL_LOCAL_PREVIEW", "true"],
    ["MEPMAIL_LOCAL_PREVIEW", "unknown"],
    ["APP_BASE_URL", "http://127.0.0.1:3482"],
    ["APP_BASE_URL", "http://mepmail.dev"],
    ["APP_BASE_URL", "https://other.example.test"],
    ["APP_BASE_URL", "https://mepmail.dev.example.test"],
    ["APP_BASE_URL", "https://user@mepmail.dev"],
    ["APP_BASE_URL", "https://user:password@mepmail.dev"],
    ["APP_BASE_URL", "https://mepmail.dev:443"],
    ["APP_BASE_URL", "https://mepmail.dev:8443"],
    ["APP_BASE_URL", "https://mepmail.dev/support"],
    ["APP_BASE_URL", "https://mepmail.dev/?review=1"],
    ["APP_BASE_URL", "https://mepmail.dev/#review"],
    ["CONTENT_REVEAL", "on"],
    ["CONTENT_REVEAL", undefined],
    ["SUPPORT_VIEW", "on"],
    ["SUPPORT_VIEW", undefined],
  ])("disables production for unsafe %s=%s before reading files", async (key, value) => {
    productionMode();
    env[key] = value;
    expect(await caller().status({ teamId })).toEqual({
      enabled: false,
      message: null,
      access: null,
    });
    await expect(caller().requestAccess(input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reads).toEqual([]);
    expect(await rows("console.held_message_review_requested")).toEqual([]);
  });

  it.each(["https://mepmail.dev", "https://mepmail.dev/"])(
    "allows explicit production only at %s without pausing billing or transport",
    async (origin) => {
      productionMode();
      env.APP_BASE_URL = origin;
      const before = { ...env };
      expect((await caller().status({ teamId })).enabled).toBe(true);
      expect(env).toEqual(before);
      expect(env.BILLING_MUTATIONS_PAUSED).toBe("0");
      expect(env.MAILBOX_TRANSPORT_ENABLED).toBe("1");
      expect(await rows("console.held_message_review_requested")).toEqual([]);
      expect(reads.every((path) => path.endsWith("/manifest.json"))).toBe(true);
    },
  );

  it.each(["missing_dir", "missing_manifest"])(
    "leaves production disabled with %s and does not issue a request or read a body",
    async (condition) => {
      productionMode();
      if (condition === "missing_dir") delete env.MEPMAIL_HELD_REVIEW_DIR;
      else files.delete(`${DIR}/manifest.json`);
      expect(await caller().status({ teamId })).toEqual({
        enabled: false,
        message: null,
        access: null,
      });
      await expect(caller().requestAccess(input())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller().revealed({ teamId, emailId, operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(reads.every((path) => path.endsWith("/manifest.json"))).toBe(true);
      expect(await rows("console.held_message_review_requested")).toEqual([]);
      expect(await rows("console.held_message_review_viewed")).toEqual([]);
    },
  );

  it.each(["staging", "production"])("refuses a cross-lane manifest in %s", async (mode) => {
    if (mode === "production") productionMode();
    manifest.audience =
      mode === "staging" ? "held-message-review-production" : "held-message-review-staging";
    writeManifest();
    await expect(caller().requestAccess(input())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await rows("console.held_message_review_requested")).toEqual([]);
    expect(reads.every((path) => path.endsWith("/manifest.json"))).toBe(true);
  });

  it.each(["stagingRevision", "productionRevision"])(
    "requires production manifest %s to match the serving revision",
    async (pin) => {
      productionMode();
      manifest[pin] = "d".repeat(40);
      writeManifest();
      await expect(caller().status({ teamId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(await rows("console.held_message_review_requested")).toEqual([]);
    },
  );

  it.each(["missing_revision", "expired", "invalid_json", "invalid_shape"])(
    "refuses production configuration with %s without issuing access",
    async (condition) => {
      productionMode();
      if (condition === "missing_revision") delete env.MILLIONSEND_REVISION;
      if (condition === "expired") {
        manifest.expiresAt = clock.toISOString();
        writeManifest();
      }
      if (condition === "invalid_json") files.set(`${DIR}/manifest.json`, Buffer.from("{"));
      if (condition === "invalid_shape") files.set(`${DIR}/manifest.json`, Buffer.from("{}"));
      await expect(caller().requestAccess(input())).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(await rows("console.held_message_review_requested")).toEqual([]);
      expect(await rows("console.held_message_review_viewed")).toEqual([]);
      expect(reads.every((path) => path.endsWith("/manifest.json"))).toBe(true);
    },
  );

  it("does not infer production mode from a production origin or manifest", async () => {
    productionMode();
    delete env.MEPMAIL_HELD_REVIEW_MODE;
    expect((await caller().status({ teamId })).enabled).toBe(false);
    expect(reads).toEqual([]);
  });

  it.each(["staging", "production"])(
    "%s refuses other teams, emails, manifest operators and revisions",
    async (mode) => {
      if (mode === "production") productionMode();
      await expect(caller().status({ teamId: randomUUID() })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        caller().requestAccess({ ...input(), emailId: randomUUID() }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      manifest.operatorId = OTHER;
      writeManifest();
      await expect(caller().status({ teamId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      manifest.operatorId = OPERATOR;
      manifest.stagingRevision = "d".repeat(40);
      writeManifest();
      await expect(caller().status({ teamId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    },
  );

  it.each(["no_hold", "sent", "missing_body", "purged", "different_team"])(
    "rejects ineligible %s without a request audit",
    async (condition) => {
      if (condition === "no_hold")
        await db
          .update(schema.teams)
          .set({ sendReviewAt: null })
          .where(eq(schema.teams.id, teamId));
      if (condition === "sent")
        await db
          .update(schema.emails)
          .set({ latestStatus: "sent" })
          .where(eq(schema.emails.id, emailId));
      if (condition === "missing_body")
        await db
          .update(schema.emails)
          .set({ bodyCiphertext: null })
          .where(eq(schema.emails.id, emailId));
      if (condition === "purged")
        await db
          .update(schema.emails)
          .set({ bodyPurgedAt: clock })
          .where(eq(schema.emails.id, emailId));
      if (condition === "different_team") {
        const otherTeam = await createTeam(db, `other-${randomUUID()}`);
        await db
          .update(schema.emails)
          .set({ teamId: otherTeam })
          .where(eq(schema.emails.id, emailId));
      }
      expect((await caller().status({ teamId })).message).toBeNull();
      await expect(caller().requestAccess(input())).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(await rows("console.held_message_review_requested")).toHaveLength(0);
    },
  );

  it.each(["staging", "production"])(
    "%s bounds manifest and access expiry and validates justification",
    async (mode) => {
      if (mode === "production") productionMode();
      await expect(
        caller().requestAccess({ ...input(), justification: "short" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      manifest.expiresAt = "2026-10-18T00:00:00.000Z";
      writeManifest();
      await expect(caller().status({ teamId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      manifest.expiresAt = "2026-10-16T22:05:00.000Z";
      writeManifest();
      const request = await caller().requestAccess(input());
      expect(request.expiresAt.toISOString()).toBe(manifest.expiresAt);
      await prepare(request.operationId);
      clock = new Date("2026-10-16T22:05:00.000Z");
      await expect(
        caller().revealed({ teamId, emailId, operationId: request.operationId }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    },
  );

  it.each([
    ["staging", "queued"],
    ["staging", "queued_quota"],
    ["production", "queued"],
    ["production", "queued_quota"],
  ] as const)(
    "%s audits one %s request, reuses it, and reveals only prepared redacted data",
    async (mode, status) => {
      if (mode === "production") productionMode();
      await db
        .update(schema.emails)
        .set({ latestStatus: status })
        .where(eq(schema.emails.id, emailId));
      const api = caller();
      const first = await api.requestAccess(input());
      const repeat = await api.requestAccess(input());
      expect(repeat).toEqual(first);
      expect(first.expiresAt.getTime() - clock.getTime()).toBe(30 * 60_000);
      expect((await api.status({ teamId })).access?.state).toBe("pending");
      await prepare(first.operationId);
      expect((await api.status({ teamId })).access?.state).toBe("ready");
      const result = await api.revealed({ teamId, emailId, operationId: first.operationId });
      expect(result).toEqual({
        subject: [{ text: "Synthetic fixture" }],
        spans: [{ text: "Public example body. " }, { text: "[redacted]", redacted: true }],
        redactions: 1,
        linkHosts: ["example.test"],
        expiresAt: first.expiresAt,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /recipient@example|synthetic ciphertext|productionBuildId|justification/,
      );
      const requested = await rows("console.held_message_review_requested");
      const viewed = await rows("console.held_message_review_viewed");
      expect(requested).toHaveLength(1);
      expect(viewed).toHaveLength(1);
      expect(
        [...requested, ...viewed].every(
          (row) => row.teamId === null && row.actorId === `user:${OPERATOR}`,
        ),
      ).toBe(true);
      const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      expect(email?.latestStatus).toBe(status);
      expect(email?.sentAt).toBeNull();
      expect(team?.sendReviewAt?.toISOString()).toBe("2026-10-14T02:58:02.000Z");
      expect(
        await db
          .select()
          .from(schema.contentAccessGrants)
          .where(eq(schema.contentAccessGrants.teamId, teamId)),
      ).toEqual([]);
    },
  );

  it("does not trust a payload file without a private prepared proof", async () => {
    const api = caller();
    const { operationId } = await api.requestAccess(input());
    files.set(`${DIR}/${operationId}.json`, Buffer.from("{}"));
    await expect(api.revealed({ teamId, emailId, operationId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(reads.filter((p) => p.endsWith(`${operationId}.json`))).toEqual([]);
    expect(await rows("console.held_message_review_viewed")).toEqual([]);
  });

  it("preserves hostname, IPv4 and IPv6 evidence as text without resolving it", async () => {
    const api = caller();
    const { operationId } = await api.requestAccess(input());
    await prepare(operationId, (payload) => {
      payload.linkHosts = ["example.test", "10.23.45.67", "::1"];
    });
    expect((await api.revealed({ teamId, emailId, operationId })).linkHosts).toEqual([
      "example.test",
      "10.23.45.67",
      "::1",
    ]);
  });

  it.each(["hash", "payload_scope", "proof_context", "unsafe_url", "oversize", "duplicate_proof"])(
    "refuses %s and emits no viewed audit",
    async (condition) => {
      const api = caller();
      const { operationId } = await api.requestAccess(input());
      await prepare(
        operationId,
        (payload) => {
          if (condition === "payload_scope") payload.teamId = randomUUID();
          if (condition === "unsafe_url")
            payload.linkHosts = ["https://example.test/private?token=fixture"];
          if (condition === "oversize") payload.spans = [{ text: "a".repeat(20_001) }];
        },
        (proof) => {
          if (condition === "proof_context") proof.productionRevision = "d".repeat(40);
        },
      );
      if (condition === "hash") files.set(`${DIR}/${operationId}.json`, Buffer.from("tampered"));
      if (condition === "duplicate_proof") {
        const [proof] = await rows("console.held_message_review_prepared");
        if (!proof) throw new Error("missing proof");
        await db.insert(schema.auditLog).values({ ...proof, id: randomUUID() });
      }
      await expect(api.revealed({ teamId, emailId, operationId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(await rows("console.held_message_review_viewed")).toEqual([]);
    },
  );

  it.each(["released", "changed_hold", "sent", "expired"])(
    "does not reveal after %s",
    async (condition) => {
      const api = caller();
      const { operationId } = await api.requestAccess(input());
      await prepare(operationId);
      if (condition === "released")
        await db
          .update(schema.teams)
          .set({ sendReviewAt: null })
          .where(eq(schema.teams.id, teamId));
      if (condition === "changed_hold")
        await db
          .update(schema.teams)
          .set({ sendReviewAt: clock })
          .where(eq(schema.teams.id, teamId));
      if (condition === "sent")
        await db
          .update(schema.emails)
          .set({ latestStatus: "sent" })
          .where(eq(schema.emails.id, emailId));
      if (condition === "expired") clock = new Date(clock.getTime() + 30 * 60_000);
      await expect(api.revealed({ teamId, emailId, operationId })).rejects.toBeDefined();
      expect(await rows("console.held_message_review_viewed")).toEqual([]);
    },
  );

  it.each(["staging", "production"])(
    "%s fails closed when the database rejects the viewed audit",
    async (mode) => {
      if (mode === "production") productionMode();
      const api = caller();
      const { operationId } = await api.requestAccess(input());
      await prepare(operationId);
      await db.execute(
        sql.raw(
          `CREATE FUNCTION reject_held_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'console.held_message_review_viewed' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$`,
        ),
      );
      await db.execute(
        sql.raw(
          "CREATE TRIGGER reject_held_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_held_review_audit()",
        ),
      );
      try {
        await expect(api.revealed({ teamId, emailId, operationId })).rejects.toBeDefined();
        expect(await rows("console.held_message_review_viewed")).toEqual([]);
      } finally {
        await db.execute(sql.raw("DROP TRIGGER reject_held_review_audit ON audit_log"));
        await db.execute(sql.raw("DROP FUNCTION reject_held_review_audit()"));
      }
    },
  );

  it.each(["staging", "production"])(
    "%s rechecks expiry after payload I/O and returns no content or viewed audit",
    async (mode) => {
      if (mode === "production") productionMode();
      const api = caller();
      const request = await api.requestAccess(input());
      await prepare(request.operationId);
      afterPayloadRead = () => {
        clock = request.expiresAt;
      };
      await expect(
        api.revealed({ teamId, emailId, operationId: request.operationId }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await rows("console.held_message_review_viewed")).toEqual([]);
    },
  );

  it.each(["staging", "production"])(
    "%s withholds content if the deadline is crossed while committing the viewed audit",
    async (mode) => {
      if (mode === "production") productionMode();
      const api = caller();
      const request = await api.requestAccess(input());
      await prepare(request.operationId);
      const transaction = db.transaction.bind(db);
      const commitDelay = vi
        .spyOn(db, "transaction")
        .mockImplementation(async (callback, options) =>
          transaction(async (tx) => {
            const result = await callback(tx);
            // The real INSERT finished; advance time before the real transaction commits.
            clock = request.expiresAt;
            return result;
          }, options),
        );
      try {
        await expect(
          api.revealed({ teamId, emailId, operationId: request.operationId }),
        ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
        expect(await rows("console.held_message_review_viewed")).toHaveLength(1);
      } finally {
        commitDelay.mockRestore();
      }
    },
  );

  it.each(["staging", "production"])(
    "%s does not issue access if the mandatory request audit cannot commit",
    async (mode) => {
      if (mode === "production") productionMode();
      await db.execute(
        sql.raw(
          `CREATE FUNCTION reject_held_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'console.held_message_review_requested' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$`,
        ),
      );
      await db.execute(
        sql.raw(
          "CREATE TRIGGER reject_held_request_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_held_request_audit()",
        ),
      );
      try {
        await expect(caller().requestAccess(input())).rejects.toMatchObject({
          code: "INTERNAL_SERVER_ERROR",
          message: "held_review_audit_failed",
        });
        expect(await rows("console.held_message_review_requested")).toEqual([]);
        expect(reads.every((path) => path.endsWith("/manifest.json"))).toBe(true);
      } finally {
        await db.execute(sql.raw("DROP TRIGGER reject_held_request_audit ON audit_log"));
        await db.execute(sql.raw("DROP FUNCTION reject_held_request_audit()"));
      }
    },
  );
});
