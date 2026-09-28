import { describe, expect, it } from "vitest";
import { ConfigError, helpText, parseConfig } from "../src/config.js";
import { CLOUD_API_URL, TRADEMARK_NOTICE } from "../src/meta.js";

const env = {
  RESEND_API_KEY: "re_x",
  MEPMAIL_API_KEY: "ms_y",
  MEPMAIL_BASE_URL: "https://api.example.com/",
};

/** The historical alias names must keep working when the primary is unset. */
const aliasEnv = {
  RESEND_API_KEY: "re_x",
  MILLIONSEND_API_KEY: "ms_y",
  MILLIONSEND_BASE_URL: "https://api.example.com/",
};

const EMAIL_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

describe("parseConfig", () => {
  it("resolves the interactive default command with env-provided credentials", () => {
    const config = parseConfig(["migrate", "--from", "resend"], env, true);
    expect(config).toMatchObject({
      command: "migrate",
      from: "resend",
      fromKey: { source: "env", value: "re_x" },
      toKey: { source: "env", value: "ms_y" },
      toUrl: "https://api.example.com",
      rps: 8,
      onConflict: "upsert",
      nonInteractive: false,
      skip: [],
      only: null,
      warnings: [],
    });
  });

  it("resolves the historical MILLIONSEND_* aliases when the MEPMAIL_* names are unset", () => {
    const config = parseConfig(["migrate", "--from", "resend"], aliasEnv, true);
    expect(config.toKey).toEqual({ source: "env", value: "ms_y" });
    expect(config.toUrl).toBe("https://api.example.com");
  });

  it("accepts --rps above Resend's default limit up to the ceiling, and remembers it was given", () => {
    const raised = parseConfig(["migrate", "--from", "resend", "--rps", "50"], env, true);
    expect(raised).toMatchObject({ rps: 50, rpsGiven: true });
    expect(parseConfig(["migrate", "--from", "resend"], env, true).rpsGiven).toBe(false);
    expect(() => parseConfig(["migrate", "--from", "resend", "--rps", "101"], env, true)).toThrow(
      "between 1 and 100",
    );
  });

  it("parses subcommands, the plan file and every flag", () => {
    const config = parseConfig(
      [
        "migrate",
        "apply",
        "plan.json",
        "--yes",
        "--rps",
        "3",
        "--skip",
        "enrichment,api-keys",
        "--only",
        "contacts",
        "--on-conflict",
        "skip",
        "--json",
        "--verbose",
        "--no-color",
        "--fresh-webhook-secrets",
        "--include-sent",
        "--fresh",
        "--report",
        "out.md",
      ],
      env,
      true,
    );
    expect(config).toMatchObject({
      command: "apply",
      planFile: "plan.json",
      from: null,
      yes: true,
      rps: 3,
      skip: ["enrichment", "api-keys"],
      only: ["contacts"],
      onConflict: "skip",
      json: true,
      nonInteractive: true,
      verbose: true,
      color: "never",
      freshWebhookSecrets: true,
      includeSent: true,
      fresh: true,
      report: "out.md",
    });
  });

  it("help and version short-circuit; no command means help", () => {
    expect(parseConfig(["--help"], {}, true).command).toBe("help");
    expect(parseConfig(["-V"], {}, true).command).toBe("version");
    expect(parseConfig([], {}, true).command).toBe("help");
  });

  it("stdin flags and command-line keys, with the process-list warning", () => {
    const config = parseConfig(
      [
        "migrate",
        "plan",
        "--from",
        "resend",
        "--from-key-stdin",
        "--to-key",
        "ms_k",
        "--to-url",
        "http://localhost:3001",
      ],
      {},
      false,
    );
    expect(config.fromKey).toEqual({ source: "stdin", value: null });
    expect(config.toKey).toEqual({ source: "flag", value: "ms_k" });
    expect(config.warnings).toEqual([
      "--to-key is visible to other users in process lists; prefer MEPMAIL_API_KEY or --to-key-stdin.",
    ]);
  });

  it("status needs no credentials even when piped", () => {
    expect(parseConfig(["migrate", "status"], {}, false).command).toBe("status");
  });

  it.each([
    [["migrate"], "Missing --from <provider>"],
    [["migrate", "--from", "mailgun"], "Unknown provider `mailgun`. Supported: resend"],
    [["deploy"], "Unknown command `deploy`"],
    [["migrate", "sync"], "Unknown command `migrate sync`"],
    [["migrate", "plan", "x.json", "--from", "resend"], "Unexpected argument `x.json`"],
    [
      ["migrate", "--from", "resend", "--rps", "0"],
      "--rps must be a whole number between 1 and 100 (got 0)",
    ],
    [["migrate", "--from", "resend", "--rps", "2.5"], "--rps must be a whole number"],
    [
      ["migrate", "--from", "resend", "--skip", "foo"],
      "Unknown resource `foo` in --skip. Known: domains, properties",
    ],
    [
      ["migrate", "--from", "resend", "--on-conflict", "merge"],
      "--on-conflict must be upsert, skip or error",
    ],
    [["migrate", "--from", "resend", "--out", "p.json"], "--out only applies to `migrate plan`"],
    [["migrate", "--from", "resend", "--to-url", "nope"], "Not a URL: nope"],
    [
      ["migrate", "--from", "resend", "--from-key", "a", "--from-key-stdin"],
      "either --from-key or --from-key-stdin",
    ],
    [["migrate", "--from", "resend", "--bogus"], "Unknown option '--bogus'. See mepmail --help"],
    [["emails"], "Missing a subcommand for `emails`. Usage: mepmail emails list"],
    [["emails", "send"], "Unknown command `emails send`. Usage: mepmail emails list"],
    [["emails", "get"], "Missing <id> for `emails get`"],
    [
      ["emails", "get", "not-an-id"],
      "`not-an-id` is not an email id. Usage: mepmail emails get <id>",
    ],
    [["emails", "list", "extra"], "Unexpected argument `extra`"],
    [["emails", "list", "--after", "not-a-uuid"], "`not-a-uuid` is not an email id for --after"],
    [
      ["emails", "list", "--limit", "0"],
      "--limit must be a whole number between 1 and 100 (got 0)",
    ],
    [["emails", "list", "--limit", "101"], "--limit must be a whole number between 1 and 100"],
    [["emails", "list", "--limit", "many"], "--limit must be a whole number"],
    [
      ["emails", "get", EMAIL_ID, "--limit", "5"],
      "--limit and --after only apply to `emails list`",
    ],
    [["doctor", "extra"], "Unexpected argument `extra`"],
    [["migrate", "status", "--dry-run"], "--dry-run is only for `doctor` and `emails`"],
    [["migrate", "plan", "--from", "resend", "--after", EMAIL_ID], "only apply to `emails list`"],
  ])("%j → %s", (argv, message) => {
    expect(() => parseConfig(argv, env, true)).toThrow(ConfigError);
    expect(() => parseConfig(argv, env, true)).toThrow(message);
  });

  it("non-interactive runs name the missing env var or flag", () => {
    expect(() => parseConfig(["migrate", "--from", "resend"], {}, false)).toThrow(
      "Missing Resend API key. Set RESEND_API_KEY or pass --from-key-stdin",
    );
    expect(() =>
      parseConfig(["migrate", "--from", "resend"], { RESEND_API_KEY: "re_x" }, false),
    ).toThrow("Missing MepMail API key. Set MEPMAIL_API_KEY or pass --to-key-stdin");
    // No instance named: MepMail Cloud, like the SDKs.
    expect(
      parseConfig(
        ["migrate", "--from", "resend", "--yes"],
        { RESEND_API_KEY: "re_x", MEPMAIL_API_KEY: "ms_y" },
        false,
      ).toUrl,
    ).toBe(CLOUD_API_URL);
    expect(() => parseConfig(["migrate", "rollback"], {}, false)).toThrow(
      "Missing MepMail API key",
    );
  });

  it("non-interactive migrate/apply/rollback need --yes up front; plan and status do not", () => {
    const message =
      "migrate/apply/rollback need --yes in non-interactive mode (or run `migrate plan` to only read).";
    for (const argv of [
      ["migrate", "--from", "resend"],
      ["migrate", "apply", "plan.json"],
      ["migrate", "rollback"],
      ["migrate", "--from", "resend", "--json"],
    ]) {
      expect(() => parseConfig(argv, env, false), argv.join(" ")).toThrow(ConfigError);
      expect(() => parseConfig(argv, env, false), argv.join(" ")).toThrow(message);
      expect(parseConfig([...argv, "--yes"], env, false).yes).toBe(true);
    }
    expect(parseConfig(["migrate", "plan", "--from", "resend"], env, false).command).toBe("plan");
    expect(parseConfig(["migrate", "status"], {}, false).command).toBe("status");
    expect(parseConfig(["migrate", "--from", "resend"], env, true).yes).toBe(false);
  });

  it("doctor and emails resolve credentials like the migration commands", () => {
    const doctor = parseConfig(["doctor"], env, true);
    expect(doctor).toMatchObject({
      command: "doctor",
      toKey: { source: "env", value: "ms_y" },
      toUrl: "https://api.example.com",
      limit: 20,
      after: null,
      dryRun: false,
    });
    // The historical aliases cover the new commands too.
    expect(parseConfig(["doctor"], aliasEnv, true).toKey).toEqual({ source: "env", value: "ms_y" });
    expect(parseConfig(["emails", "list"], env, true)).toMatchObject({
      command: "emails",
      emailsAction: "list",
      emailId: null,
      limit: 20,
    });
    expect(
      parseConfig(["emails", "list", "--limit", "100", "--after", EMAIL_ID], env, true),
    ).toMatchObject({ limit: 100, after: EMAIL_ID });
    expect(parseConfig(["emails", "get", EMAIL_ID, "--json"], env, true)).toMatchObject({
      command: "emails",
      emailsAction: "get",
      emailId: EMAIL_ID,
      json: true,
      nonInteractive: true,
    });
    // No instance named → MepMail Cloud, exactly like a migration.
    expect(parseConfig(["emails", "list"], { MEPMAIL_API_KEY: "ms_y" }, false).toUrl).toBe(
      CLOUD_API_URL,
    );
    // The key is mandatory once piped, and named when it is missing.
    expect(() => parseConfig(["doctor"], {}, false)).toThrow(
      "Missing MepMail API key. Set MEPMAIL_API_KEY or pass --to-key-stdin",
    );
    expect(() => parseConfig(["emails", "list"], {}, false)).toThrow("Missing MepMail API key");
  });

  it("--dry-run needs no key: it is the one run that never reaches the API", () => {
    const config = parseConfig(["doctor", "--dry-run"], {}, false);
    expect(config).toMatchObject({ command: "doctor", dryRun: true, toUrl: CLOUD_API_URL });
    expect(
      parseConfig(["emails", "get", EMAIL_ID, "--dry-run", "--json"], {}, false),
    ).toMatchObject({
      dryRun: true,
      emailId: EMAIL_ID,
      toUrl: CLOUD_API_URL,
    });
    // Without --dry-run the same invocation is a usage error.
    expect(() => parseConfig(["doctor"], {}, false)).toThrow(ConfigError);
  });

  it("--color takes auto, always or never; --no-color is never; the default is auto", () => {
    const argv = ["migrate", "--from", "resend"];
    expect(parseConfig(argv, env, true).color).toBe("auto");
    for (const mode of ["auto", "always", "never"]) {
      expect(parseConfig([...argv, "--color", mode], env, true).color).toBe(mode);
    }
    expect(parseConfig([...argv, "--no-color", "--color", "never"], env, true).color).toBe("never");
    expect(() => parseConfig([...argv, "--color", "yes"], env, true)).toThrow(
      "--color must be auto, always or never (got yes).",
    );
    expect(() => parseConfig([...argv, "--no-color", "--color", "always"], env, true)).toThrow(
      "Pass either --color or --no-color, not both.",
    );
  });
});

describe("helpText", () => {
  it("covers the grammar, every flag, env vars, exit codes and the trademark footer", () => {
    const text = helpText();
    for (const needle of [
      "migrate plan --from resend [--out plan.json]",
      "migrate apply [plan.json] [--yes]",
      "migrate rollback [--yes]",
      "mepmail doctor",
      "mepmail emails list [--limit 20]",
      "mepmail emails get <id>",
      "--limit <n>",
      "--after <id>",
      "--dry-run",
      "the MepMail API could not be reached (doctor/emails)",
      "--from-key-stdin",
      "--to-key-stdin",
      "--fresh-webhook-secrets",
      "--include-sent",
      "--on-conflict",
      "--color <mode>",
      "--no-color                 same as --color never",
      "FORCE_COLOR",
      "--fresh                    ignore resume progress; keeps what earlier runs created so rollback still works",
      "RESEND_API_KEY",
      "MEPMAIL_API_KEY",
      "MEPMAIL_BASE_URL",
      "DO_NOT_TRACK",
      "3 partial",
      TRADEMARK_NOTICE,
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toMatch(/!\s/);
  });

  it("starts every usage description in the same column", () => {
    // The Usage block is read column-wise: one line drifting a character is a
    // defect in the help, not a matter of taste.
    const descriptions = helpText()
      .split("\n")
      .filter((line) => line.startsWith("  mepmail "))
      .map((line) => / {2,}\S/.exec(line.slice(3)))
      .filter((match) => match !== null)
      .map((match) => 3 + match.index + match[0].length - 1);
    expect(descriptions.length).toBeGreaterThan(5);
    expect(new Set(descriptions).size).toBe(1);
  });
});
