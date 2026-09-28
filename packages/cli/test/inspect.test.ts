import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import { VERSION } from "../src/meta.js";
import { createApiKey, type LiveApi, startLiveApi } from "./helpers/live-api.js";

/**
 * The day-to-day commands (`doctor`, `emails`) run in-process against the real
 * API on PGlite, exactly like the migration tests: the HTTP client, the auth,
 * the cursor walk and the pacing are all the shipping ones.
 */

let api: LiveApi;
let cwd: string;
/** Two emails from the same verified sender: one delivered with a text body, one scheduled with HTML only. */
let deliveredId: string;
let scheduledId: string;
let empty: LiveApi | undefined;

function collector() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return {
    stream,
    get text() {
      return text;
    },
  };
}

type RunOptions = {
  env?: Record<string, string | undefined>;
  stdin?: string;
  fetch?: typeof fetch;
};

async function run(argv: string[], options: RunOptions = {}) {
  const input = new PassThrough();
  input.end(options.stdin ?? "");
  const stdout = collector();
  const stderr = collector();
  const code = await main(argv, {
    stdin: input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { MEPMAIL_API_KEY: api.apiKey, MEPMAIL_BASE_URL: api.baseUrl, ...options.env },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    cwd,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function post<T>(target: LiveApi, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Nothing that could open the account may reach a stream. */
function expectNoSecrets(...texts: string[]): void {
  for (const text of texts) expect(text).not.toContain(api.apiKey);
}

beforeAll(async () => {
  delete process.env.FORCE_COLOR;
  api = await startLiveApi({
    isCloud: true,
    appBaseUrl: "https://app.example.test",
    plan: "starter",
  });
  cwd = mkdtempSync(join(tmpdir(), "mepmail-inspect-"));
  // A verified sender plus a domain still waiting for its DNS records: doctor
  // has to tell one from the other.
  const verified = await post<{ id: string }>(api, "/domains", {
    name: "example.com",
    region: "us-east-1",
  });
  await api.db
    .update(schema.domains)
    .set({ status: "verified" })
    .where(eq(schema.domains.id, verified.id));
  await post(api, "/domains", { name: "waiting.example.net", region: "us-east-1" });

  const delivered = await post<{ id: string }>(api, "/emails", {
    from: "Acme <hello@example.com>",
    to: ["first@example.net"],
    subject: "Primeira entrega",
    text: "Olá!\nSegunda linha do corpo.",
  });
  deliveredId = delivered.id;
  // An hour in the past keeps the "oldest first" order deterministic.
  await api.db
    .update(schema.emails)
    .set({ createdAt: new Date(Date.now() - 3_600_000), latestStatus: "delivered" })
    .where(eq(schema.emails.id, deliveredId));

  const scheduled = await post<{ id: string }>(api, "/emails", {
    from: "Acme <hello@example.com>",
    to: ["second@example.net"],
    subject: "Segunda, agendada",
    html: "<p>HTML only</p>",
    scheduled_at: "in 2 hours",
  });
  scheduledId = scheduled.id;
}, 120_000);

afterAll(async () => {
  await Promise.all([api.stop(), empty?.stop()]);
}, 60_000);

describe("mepmail doctor", () => {
  it("walks the account and prints one line per check", async () => {
    const { code, stdout, stderr } = await run(["doctor"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`mepmail doctor — ${VERSION}`);
    expect(stdout).toContain("✓ CLI");
    expect(stdout).toContain("✓ Key");
    expect(stdout).toContain("✓ API");
    expect(stdout).toContain("reachable");
    expect(stdout).toContain("✓ Auth");
    expect(stdout).toContain("plan Starter");
    // The verified domain counts, the pending one is named.
    expect(stdout).toContain("1 domain verified");
    expect(stdout).toContain("waiting.example.net (pending)");
    expect(stdout).toContain("✓ Sending");
    expect(stdout).toContain("guardrail ok");
    expect(stdout).toContain("warning");
    expectNoSecrets(stdout, stderr);
  });

  it("prints the same checks as JSON on stdout", async () => {
    const { code, stdout, stderr } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      version: string;
      url: string;
      ok: boolean;
      skipped: string[];
      checks: { id: string; status: string; detail: string }[];
    };
    expect(report.command).toBe("doctor");
    expect(report.version).toBe(VERSION);
    expect(report.url).toBe(api.baseUrl);
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual([]);
    expect(report.checks.map((c) => c.id)).toEqual([
      "cli",
      "key",
      "api",
      "auth",
      "domains",
      "sending",
    ]);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
    // Human lines stay off stdout under --json.
    expect(stderr).toBe("");
    expectNoSecrets(stdout);
  });

  it("rejects a wrong key with exit 2 and points at the env var", async () => {
    const { code, stdout, stderr } = await run(["doctor"], {
      env: { MEPMAIL_API_KEY: "ms_not_a_real_key_000000000000" },
    });
    expect(code).toBe(2);
    expect(stdout).toContain("✓ API");
    expect(stdout).toContain("✗ Auth");
    expect(stdout).toContain("MEPMAIL_API_KEY");
    expect(stderr).toBe("");
    // A rejected key stops the checks that need it — and each is named once.
    expect(stdout).toContain("domains, sending skipped until the line above passes");
    expectNoSecrets(stderr);
  });

  it("tells a sending-only key apart from a broken one", async () => {
    const sendingOnly = await createApiKey(api.db, api.teamId, "sending_access");
    const { code, stdout } = await run(["doctor"], { env: { MEPMAIL_API_KEY: sendingOnly } });
    expect(code).toBe(2);
    expect(stdout).toContain("sending-only");
    expect(stdout).not.toContain(sendingOnly);
  });

  it("reports an unreachable API with exit 2, a hint, and no key problem", async () => {
    // Every attempt fails without touching the network: the CLI's own retry
    // (1s, 2s, 4s, 8s) is advanced by fake timers, as in http.test.ts.
    vi.useFakeTimers();
    try {
      const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const pending = run(["doctor"], { fetch: failing as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(30_000);
      const { code, stdout } = await pending;
      expect(code).toBe(2);
      expect(stdout).toContain("✗ API");
      expect(stdout).toContain("✓ Key");
      expect(stdout).toContain("MEPMAIL_BASE_URL");
      expect(failing).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("--dry-run names the requests and touches nothing, even without a key", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("must not be called"));
    const { code, stdout } = await run(["doctor", "--dry-run"], {
      env: { MEPMAIL_API_KEY: undefined },
      fetch: failing as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("dry run");
    expect(stdout).toContain(api.baseUrl);
    expect(stdout).toContain("GET /health");
    expect(stdout).toContain("GET /usage");
    expect(stdout).toContain("GET /domains");
    expect(stdout).toContain("GET /deliverability");
    expect(stdout).toContain("missing");
    expect(failing).not.toHaveBeenCalled();
  });

  it("--dry-run --json is a single JSON object on stdout", async () => {
    const { code, stdout } = await run(["doctor", "--dry-run", "--json"], {
      env: { MEPMAIL_API_KEY: undefined },
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { dry_run: boolean; requests: string[]; key: string };
    expect(report.dry_run).toBe(true);
    expect(report.requests).toEqual([
      "GET /health",
      "GET /usage",
      "GET /domains",
      "GET /deliverability",
    ]);
    expect(report.key).toContain("missing");
  });

  it("warns, without failing, on an account with nothing set up", async () => {
    empty = await startLiveApi({ isCloud: true, slug: "empty" });
    const input = new PassThrough();
    input.end("");
    const stdout = collector();
    const stderr = collector();
    const code = await main(["doctor"], {
      stdin: input,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { MEPMAIL_API_KEY: empty.apiKey, MEPMAIL_BASE_URL: empty.baseUrl },
      cwd,
    });
    expect(code).toBe(0);
    expect(stdout.text).toContain("no sending domain yet");
    expect(stdout.text).toContain("warning");
    expect(stderr.text).toBe("");
  }, 120_000);
});

describe("mepmail emails", () => {
  it("list: prints the page oldest first and flags the scheduled one", async () => {
    const { code, stdout, stderr } = await run(["emails", "list"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("2 emails");
    expect(stdout).toContain("Primeira entrega");
    expect(stdout).toContain("Segunda, agendada");
    expect(stdout.indexOf(deliveredId)).toBeLessThan(stdout.indexOf(scheduledId));
    expect(stdout).toContain("delivered");
    expect(stdout).toContain("scheduled");
    expect(stdout).not.toContain("next page");
    expectNoSecrets(stdout, stderr);
  });

  it("list --json: the API page, field for field", async () => {
    const { code, stdout, stderr } = await run(["emails", "list", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const page = JSON.parse(stdout) as {
      object: string;
      has_more: boolean;
      data: { id: string; subject: string; created_at: string; last_event: string; to: string[] }[];
    };
    expect(page.object).toBe("list");
    expect(page.has_more).toBe(false);
    expect(page.data.map((e) => e.id)).toEqual([deliveredId, scheduledId]);
    expect(page.data[0]).toMatchObject({
      subject: "Primeira entrega",
      last_event: "delivered",
      to: ["first@example.net"],
    });
    expect(page.data[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectNoSecrets(stdout);
  });

  it("list --limit 1: one row and the cursor to continue", async () => {
    const { code, stdout } = await run(["emails", "list", "--limit", "1"]);
    expect(code).toBe(0);
    expect(stdout).toContain("1 email (more available)");
    expect(stdout).toContain("Primeira entrega");
    expect(stdout).not.toContain("Segunda, agendada");
    expect(stdout).toContain(`next page: mepmail emails list --after ${deliveredId}`);
  });

  it("list --after continues where the previous page stopped", async () => {
    const { code, stdout } = await run(["emails", "list", "--after", deliveredId, "--json"]);
    expect(code).toBe(0);
    const page = JSON.parse(stdout) as { data: { id: string }[]; has_more: boolean };
    expect(page.data.map((e) => e.id)).toEqual([scheduledId]);
    expect(page.has_more).toBe(false);
  });

  it("get: the metadata block and the stored text body", async () => {
    const { code, stdout, stderr } = await run(["emails", "get", deliveredId]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Acme <hello@example.com>");
    expect(stdout).toContain("Primeira entrega");
    expect(stdout).toContain("first@example.net");
    expect(stdout).toContain("delivered");
    expect(stdout).toContain("Text");
    expect(stdout).toContain("Segunda linha do corpo.");
    expectNoSecrets(stdout, stderr);
  });

  it("get --json: the whole email, html and text as stored", async () => {
    const { code, stdout } = await run(["emails", "get", scheduledId, "--json"]);
    expect(code).toBe(0);
    const email = JSON.parse(stdout) as {
      object: string;
      id: string;
      subject: string;
      html: string | null;
      text: string | null;
      scheduled_at: string | null;
      message_id: string;
    };
    expect(email.object).toBe("email");
    expect(email.id).toBe(scheduledId);
    expect(email.subject).toBe("Segunda, agendada");
    expect(email.html).toBe("<p>HTML only</p>");
    expect(email.text).toBeNull();
    expect(email.scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(email.message_id).toContain("@");
    expectNoSecrets(stdout);
  });

  it("get: an HTML-only body points at --json instead of dumping markup", async () => {
    const { code, stdout } = await run(["emails", "get", scheduledId]);
    expect(code).toBe(0);
    expect(stdout).toContain("HTML body only");
    expect(stdout).not.toContain("<p>HTML only</p>");
    // The same word the list uses for an email waiting for its due time,
    // instead of the API's raw `queued` event.
    expect(stdout).toContain("scheduled");
    expect(stdout).not.toContain("queued");
  });

  it("get: refuses anything that is not an id before calling the API", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("must not be called"));
    const { code, stdout, stderr } = await run(["emails", "get", "not-an-id"], {
      fetch: failing as unknown as typeof fetch,
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("emails get");
    expect(failing).not.toHaveBeenCalled();
  });

  it("list: exit 2 and a hint when the key is refused", async () => {
    const { code, stdout, stderr } = await run(["emails", "list", "--json"], {
      env: { MEPMAIL_API_KEY: "ms_not_a_real_key_000000000000" },
    });
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("401");
    expect(stderr).toContain("MEPMAIL_API_KEY");
  });

  it("list an empty account without pretending it is an error", async () => {
    const fresh = await startLiveApi({ isCloud: true, slug: "empty-mail" });
    try {
      const input = new PassThrough();
      input.end("");
      const stdout = collector();
      const code = await main(["emails", "list"], {
        stdin: input,
        stdout: stdout.stream,
        stderr: collector().stream,
        env: { MEPMAIL_API_KEY: fresh.apiKey, MEPMAIL_BASE_URL: fresh.baseUrl },
        cwd,
      });
      expect(code).toBe(0);
      expect(stdout.text).toContain("No emails");
      expect(stdout.text).toContain("doctor");
    } finally {
      await fresh.stop();
    }
  }, 120_000);

  it("--dry-run names the request and touches nothing", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("must not be called"));
    const { code, stdout } = await run(["emails", "list", "--limit", "5", "--dry-run"], {
      env: { MEPMAIL_API_KEY: undefined },
      fetch: failing as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("GET /emails?limit=5");
    expect(stdout).toContain(api.baseUrl);
    expect(failing).not.toHaveBeenCalled();
  });
});

describe("mepmail emails: usage errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a missing subcommand", async () => {
    const { code, stderr } = await run(["emails"]);
    expect(code).toBe(1);
    expect(stderr).toContain("mepmail emails list");
  });

  it("rejects an unknown subcommand", async () => {
    const { code, stderr } = await run(["emails", "send"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command `emails send`");
  });

  it("rejects a missing id", async () => {
    const { code, stderr } = await run(["emails", "get"]);
    expect(code).toBe(1);
    expect(stderr).toContain("emails get <id>");
  });

  it("rejects a limit outside 1-100", async () => {
    for (const limit of ["0", "101", "many"]) {
      const { code, stderr } = await run(["emails", "list", "--limit", limit]);
      expect(code).toBe(1);
      expect(stderr).toContain("--limit");
    }
  });

  it("keeps --limit and --dry-run off the migration commands", async () => {
    const limited = await run(["migrate", "status", "--limit", "5"]);
    expect(limited.code).toBe(1);
    expect(limited.stderr).toContain("only apply to `emails list`");
    const dry = await run(["migrate", "plan", "--from", "resend", "--dry-run"], {
      env: { RESEND_API_KEY: "re_x" },
    });
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("--dry-run");
  });
});
