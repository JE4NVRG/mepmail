import { parseArgs } from "node:util";
import { CLOUD_API_URL, TRADEMARK_NOTICE, VERSION } from "./meta.js";
import { PROVIDERS, type ProviderId, RESOURCES, type Resource } from "./model.js";
import { providers } from "./providers/index.js";
import { COLOR_MODES, type ColorMode } from "./theme.js";
import { isUuid, stripTrailingSlashes } from "./utils.js";

export type Command =
  | "migrate"
  | "plan"
  | "apply"
  | "status"
  | "rollback"
  | "doctor"
  | "emails"
  | "help"
  | "version";

/** `emails list` / `emails get <id>`. */
export type EmailsAction = "list" | "get";

export type KeySource = "env" | "flag" | "stdin" | "prompt";

/** Where a key comes from; `value` is set for env/flag, read later for stdin/prompt. */
export interface KeyInput {
  source: KeySource;
  value: string | null;
}

/** Mirrors the API's `on_conflict` for POST /contacts/batch. */
export type OnConflict = "upsert" | "skip" | "error";

export interface Config {
  command: Command;
  /** `migrate apply <file>` */
  planFile: string | null;
  /** `emails list` / `emails get`; null for every other command. */
  emailsAction: EmailsAction | null;
  /** `emails get <id>`; validated here so a typo costs no request. */
  emailId: string | null;
  /** `emails list` page size, 1-100. */
  limit: number;
  /** `emails list` cursor: the id of the last email of the previous page. */
  after: string | null;
  /** `doctor` / `emails`: name the requests and exit without calling anything. */
  dryRun: boolean;
  from: ProviderId | null;
  fromKey: KeyInput;
  toKey: KeyInput;
  /** Trailing slash stripped; null means ask (Cloud or self-hosted URL). */
  toUrl: string | null;
  rps: number;
  /** --rps was passed: the limit detected on connect then never changes the rate. */
  rpsGiven: boolean;
  only: Resource[] | null;
  skip: Resource[];
  onConflict: OnConflict;
  yes: boolean;
  nonInteractive: boolean;
  json: boolean;
  out: string | null;
  report: string | null;
  color: ColorMode;
  verbose: boolean;
  freshWebhookSecrets: boolean;
  includeSent: boolean;
  fresh: boolean;
  /** Printed to stderr before anything runs (e.g. a key passed on the command line). */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_RPS = 8;
/** Resend's default team limit; shared with the account's production sending. */
export const MAX_RPS = 10;
/** Above 10, --rps is only useful after the provider raised the limit; the ceiling catches typos. */
export const RPS_CEILING = 100;
/** Requests per second left to production sending when a raised limit is detected and --rps was not given. */
export const RPS_HEADROOM = 2;

/** `emails list` page size when --limit is not given (the API's own default). */
export const EMAIL_PAGE = 20;
/** The API's ceiling for one page (listQuerySchema: limit 1-100). */
export const EMAIL_PAGE_MAX = 100;

export const TARGET_KEY_ENV = "MEPMAIL_API_KEY";
export const TARGET_URL_ENV = "MEPMAIL_BASE_URL";
/** Historical alias env names, still honored when the primary is unset. */
export const TARGET_KEY_ENV_ALIAS = "MILLIONSEND_API_KEY";
export const TARGET_URL_ENV_ALIAS = "MILLIONSEND_BASE_URL";

/** RESEND_API_KEY for `resend`. */
export const sourceKeyEnv = (provider: ProviderId): string => `${provider.toUpperCase()}_API_KEY`;

const OPTIONS = {
  from: { type: "string" },
  "from-key": { type: "string" },
  "from-key-stdin": { type: "boolean" },
  "to-url": { type: "string" },
  "to-key": { type: "string" },
  "to-key-stdin": { type: "boolean" },
  rps: { type: "string" },
  only: { type: "string" },
  skip: { type: "string" },
  "on-conflict": { type: "string" },
  yes: { type: "boolean", short: "y" },
  "non-interactive": { type: "boolean" },
  json: { type: "boolean" },
  out: { type: "string" },
  limit: { type: "string" },
  after: { type: "string" },
  "dry-run": { type: "boolean" },
  report: { type: "string" },
  color: { type: "string" },
  "no-color": { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  "fresh-webhook-secrets": { type: "boolean" },
  "include-sent": { type: "boolean" },
  fresh: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

const SUBCOMMANDS = ["plan", "apply", "status", "rollback"] as const;
const GRAMMAR =
  "mepmail migrate --from resend | migrate plan | migrate apply [plan.json] | migrate status | migrate rollback | doctor | emails list | emails get <id>";
const EMAILS_GRAMMAR = "mepmail emails list | mepmail emails get <id>";

function resourceList(flag: string, value: string | undefined): Resource[] | null {
  if (value === undefined) return null;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!(RESOURCES as readonly string[]).includes(name)) {
      throw new ConfigError(
        `Unknown resource \`${name}\` in ${flag}. Known: ${RESOURCES.join(", ")}`,
      );
    }
  }
  return names as Resource[];
}

function keyInput(
  envName: string,
  env: NodeJS.ProcessEnv,
  stdinFlag: boolean,
  flagValue: string | undefined,
  flagName: string,
  warnings: string[],
): KeyInput {
  if (stdinFlag && flagValue !== undefined) {
    throw new ConfigError(`Pass either ${flagName} or ${flagName}-stdin, not both.`);
  }
  const fromEnv = env[envName];
  if (fromEnv !== undefined && fromEnv !== "") return { source: "env", value: fromEnv };
  if (stdinFlag) return { source: "stdin", value: null };
  if (flagValue !== undefined) {
    warnings.push(
      `${flagName} is visible to other users in process lists; prefer ${envName} or ${flagName}-stdin.`,
    );
    return { source: "flag", value: flagValue };
  }
  return { source: "prompt", value: null };
}

function apiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Not a URL: ${value}. Expected e.g. ${CLOUD_API_URL}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`The MepMail API URL must be http(s): ${value}`);
  }
  return stripTrailingSlashes(value);
}

/**
 * Flags + environment → Config, or a ConfigError naming exactly what to set.
 * Pure: reads nothing but its arguments, so the same argv is decidable in tests.
 */
export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY: boolean = process.stdin.isTTY === true,
): Config {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    const reason = (error as Error).message.split(". ")[0] ?? "Bad arguments";
    throw new ConfigError(`${reason}. See mepmail --help`);
  }

  if (values.version === true) return minimal("version");
  if (values.help === true || positionals.length === 0) return minimal("help");

  const [top, sub, file, ...rest] = positionals;
  let command: Command;
  let emailsAction: EmailsAction | null = null;
  let planFile: string | null = null;
  let emailId: string | null = null;
  if (top === "migrate") {
    if (sub !== undefined && !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new ConfigError(`Unknown command \`migrate ${sub}\`. Usage: ${GRAMMAR}`);
    }
    command = (sub as Command | undefined) ?? "migrate";
    if (file !== undefined && command !== "apply") {
      throw new ConfigError(`Unexpected argument \`${file}\`. Usage: ${GRAMMAR}`);
    }
    planFile = file ?? null;
  } else if (top === "doctor") {
    if (sub !== undefined) {
      throw new ConfigError(`Unexpected argument \`${sub}\`. Usage: ${GRAMMAR}`);
    }
    command = "doctor";
  } else if (top === "emails") {
    if (sub !== "list" && sub !== "get") {
      throw new ConfigError(
        sub === undefined
          ? `Missing a subcommand for \`emails\`. Usage: ${EMAILS_GRAMMAR}`
          : `Unknown command \`emails ${sub}\`. Usage: ${EMAILS_GRAMMAR}`,
      );
    }
    command = "emails";
    emailsAction = sub;
    if (sub === "get") {
      if (file === undefined) {
        throw new ConfigError(`Missing <id> for \`emails get\`. Usage: ${EMAILS_GRAMMAR}`);
      }
      if (!isUuid(file)) {
        throw new ConfigError(
          `\`${file}\` is not an email id. Usage: mepmail emails get <id> — copy one from \`mepmail emails list\`.`,
        );
      }
      emailId = file;
    } else if (file !== undefined) {
      throw new ConfigError(`Unexpected argument \`${file}\`. Usage: ${EMAILS_GRAMMAR}`);
    }
  } else {
    throw new ConfigError(`Unknown command \`${top}\`. Usage: ${GRAMMAR}`);
  }
  if (rest.length > 0) {
    throw new ConfigError(`Unexpected argument \`${rest[0]}\`. Usage: ${GRAMMAR}`);
  }

  const warnings: string[] = [];
  const json = values.json === true;
  const nonInteractive = values["non-interactive"] === true || json || !stdinIsTTY;
  /** `doctor` and `emails`: read-only, and the only commands --dry-run speaks to. */
  const inspectCommand = command === "doctor" || command === "emails";
  const mutation = command === "migrate" || command === "apply" || command === "rollback";
  const dryRun = values["dry-run"] === true;
  if (dryRun && !inspectCommand) {
    throw new ConfigError(
      "--dry-run is only for `doctor` and `emails`; `migrate plan` is already read-only.",
    );
  }

  const paged = command === "emails" && emailsAction === "list";
  if ((values.limit !== undefined || values.after !== undefined) && !paged) {
    throw new ConfigError("--limit and --after only apply to `emails list`.");
  }
  let limit = EMAIL_PAGE;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EMAIL_PAGE_MAX) {
      throw new ConfigError(
        `--limit must be a whole number between 1 and ${EMAIL_PAGE_MAX} (got ${values.limit}).`,
      );
    }
  }
  // The API types the cursor as a uuid (`after: z.uuid()`), so a typo would only
  // come back as a 422; caught here it costs no request and exits 1, as a usage
  // error, exactly like the id of `emails get`.
  let after: string | null = null;
  if (values.after !== undefined) {
    if (!isUuid(values.after)) {
      throw new ConfigError(
        `\`${values.after}\` is not an email id for --after. Use the id a previous page printed: \`mepmail emails list --limit 1\`.`,
      );
    }
    after = values.after;
  }

  let from: ProviderId | null = null;
  if (values.from !== undefined) {
    if (!(PROVIDERS as readonly string[]).includes(values.from)) {
      throw new ConfigError(
        `Unknown provider \`${values.from}\`. Supported: ${PROVIDERS.join(", ")}`,
      );
    }
    from = values.from as ProviderId;
  }
  const needsSource = command === "migrate" || command === "plan" || command === "apply";
  if (needsSource && from === null && planFile === null) {
    throw new ConfigError(
      `Missing --from <provider>. Only \`resend\` is supported: mepmail migrate${sub === undefined ? "" : ` ${sub}`} --from resend`,
    );
  }

  /** Primary env names first; the historical aliases keep working when unset. */
  const envResolved: typeof env = {
    ...env,
    [TARGET_KEY_ENV]: env[TARGET_KEY_ENV] ?? env[TARGET_KEY_ENV_ALIAS],
    [TARGET_URL_ENV]: env[TARGET_URL_ENV] ?? env[TARGET_URL_ENV_ALIAS],
  };
  const fromKey = keyInput(
    sourceKeyEnv(from ?? "resend"),
    env,
    values["from-key-stdin"] === true,
    values["from-key"],
    "--from-key",
    warnings,
  );
  const toKey = keyInput(
    TARGET_KEY_ENV,
    envResolved,
    values["to-key-stdin"] === true,
    values["to-key"],
    "--to-key",
    warnings,
  );
  const toUrlRaw = values["to-url"] ?? envResolved[TARGET_URL_ENV];
  let toUrl = toUrlRaw === undefined || toUrlRaw === "" ? null : apiUrl(toUrlRaw);

  const needsTarget = needsSource || command === "rollback" || inspectCommand;
  // Like the SDKs, the target is MepMail Cloud unless an instance URL is named;
  // a terminal still asks, since a self-hoster's key against Cloud is only a 401.
  if (nonInteractive && needsTarget && toUrl === null) toUrl = CLOUD_API_URL;
  // --dry-run never touches the API, so it must not demand a key either.
  if (nonInteractive && needsTarget && !dryRun) {
    if (needsSource && fromKey.source === "prompt") {
      throw new ConfigError(
        `Missing ${providers[from ?? "resend"].label} API key. Set ${sourceKeyEnv(from ?? "resend")} or pass --from-key-stdin (non-interactive mode never prompts).`,
      );
    }
    if (toKey.source === "prompt") {
      throw new ConfigError(
        `Missing MepMail API key. Set ${TARGET_KEY_ENV} or pass --to-key-stdin (non-interactive mode never prompts).`,
      );
    }
    // Decided here, before any network call: the confirmation would only come after the whole source is read.
    if (mutation && values.yes !== true) {
      throw new ConfigError(
        "migrate/apply/rollback need --yes in non-interactive mode (or run `migrate plan` to only read).",
      );
    }
  }

  let rps = DEFAULT_RPS;
  const rpsGiven = values.rps !== undefined;
  if (values.rps !== undefined) {
    rps = Number(values.rps);
    if (!Number.isInteger(rps) || rps < 1 || rps > RPS_CEILING) {
      throw new ConfigError(
        `--rps must be a whole number between 1 and ${RPS_CEILING} (got ${values.rps}).`,
      );
    }
  }

  const onConflict = values["on-conflict"] ?? "upsert";
  if (onConflict !== "upsert" && onConflict !== "skip" && onConflict !== "error") {
    throw new ConfigError(`--on-conflict must be upsert, skip or error (got ${onConflict}).`);
  }

  if (values.out !== undefined && command !== "plan") {
    throw new ConfigError("--out only applies to `migrate plan`.");
  }

  const color = values.color ?? (values["no-color"] === true ? "never" : "auto");
  if (!(COLOR_MODES as readonly string[]).includes(color)) {
    throw new ConfigError(`--color must be auto, always or never (got ${color}).`);
  }
  if (values["no-color"] === true && color !== "never") {
    throw new ConfigError("Pass either --color or --no-color, not both.");
  }

  return {
    command,
    planFile,
    emailsAction,
    emailId,
    limit,
    after,
    dryRun,
    from,
    fromKey,
    toKey,
    toUrl,
    rps,
    rpsGiven,
    only: resourceList("--only", values.only),
    skip: resourceList("--skip", values.skip) ?? [],
    onConflict,
    yes: values.yes === true,
    nonInteractive,
    json,
    out: values.out ?? null,
    report: values.report ?? null,
    color: color as ColorMode,
    verbose: values.verbose === true,
    freshWebhookSecrets: values["fresh-webhook-secrets"] === true,
    includeSent: values["include-sent"] === true,
    fresh: values.fresh === true,
    warnings,
  };
}

function minimal(command: "help" | "version"): Config {
  return {
    command,
    planFile: null,
    emailsAction: null,
    emailId: null,
    limit: EMAIL_PAGE,
    after: null,
    dryRun: false,
    from: null,
    fromKey: { source: "prompt", value: null },
    toKey: { source: "prompt", value: null },
    toUrl: null,
    rps: DEFAULT_RPS,
    rpsGiven: false,
    only: null,
    skip: [],
    onConflict: "upsert",
    yes: false,
    nonInteractive: true,
    json: false,
    out: null,
    report: null,
    color: "auto",
    verbose: false,
    freshWebhookSecrets: false,
    includeSent: false,
    fresh: false,
    warnings: [],
  };
}

export function helpText(): string {
  return `mepmail ${VERSION} — move an email account to MepMail, and use it day to day

Usage
  mepmail migrate --from resend                          connect, choose resources, plan, confirm, apply, summary
  mepmail migrate plan --from resend [--out plan.json]   read-only; exit 0 nothing to do, 2 changes, 1 error
  mepmail migrate apply [plan.json] [--yes]              apply a saved plan, or plan and apply in one go
  mepmail migrate status                                 what the last run created and what is left
  mepmail migrate rollback [--yes]                       delete only what this tool created
  mepmail doctor                                         version, key, API, domains and sending health
  mepmail emails list [--limit ${EMAIL_PAGE}] [--after <id>]        the team's emails, oldest first
  mepmail emails get <id>                                one email, with its stored body
  mepmail --help | --version

Options
  --from <provider>          source provider; only \`resend\` exists
  --from-key-stdin           read the source API key from stdin (first line)
  --from-key <key>           source API key as an argument (visible in process lists; prefer the env var)
  --to-url <url>             MepMail API URL of a self-hosted instance (default ${CLOUD_API_URL}; a terminal asks)
  --to-key-stdin             read the MepMail API key from stdin (second line when both stdin flags are set)
  --to-key <key>             MepMail API key as an argument (same caveat)
  --rps <n>                  requests per second against the source (default ${DEFAULT_RPS}). Resend's team limit is ${MAX_RPS}, shared
                             with your production sending; the CLI prints the limit it detects and warns above it.
                             Go past ${MAX_RPS} only after Resend raised your limit (up to ${RPS_CEILING})
  --only <a,b>               migrate only these resources
  --skip <a,b>               skip these resources; \`enrichment\` is the per-contact properties/topics pass
  --on-conflict <mode>       contacts that already exist on the target: upsert (default), skip, error
  --include-sent             import sent broadcasts as drafts (skipped by default)
  --fresh-webhook-secrets    mint new webhook signing secrets instead of copying them (shown once in the report)
  --fresh                    ignore resume progress; keeps what earlier runs created so rollback still works
  --out <file>               \`migrate plan\`: write the plan as JSON
  --limit <n>                \`emails list\`: how many emails per page, 1-${EMAIL_PAGE_MAX} (default ${EMAIL_PAGE})
  --after <id>               \`emails list\`: start after this email id (the last one a previous page printed)
  --dry-run                  \`doctor\` / \`emails\`: print the requests that would be made and call nothing
  --report <file>            also write the Markdown report to this path
  -y, --yes                  skip confirmations
  --non-interactive          never prompt; a missing input is exit 1 (automatic when stdin is not a terminal, and with --json)
  --json                     JSON on stdout, progress on stderr
  -v, --verbose              log every request: GET /contacts?limit=100 → 200 (143 ms)
  --color <mode>             auto (default: colors on a terminal, none when piped or NO_COLOR is set), always, never
  --no-color                 same as --color never
  -h, --help                 this text
  -V, --version              print the version

Resources
  ${RESOURCES.join(", ")}

Environment
  RESEND_API_KEY             source API key (full access; the tool only reads from Resend)
  ${TARGET_KEY_ENV}        MepMail API key (full access)
  ${TARGET_URL_ENV}       MepMail API URL, same as --to-url
  NO_COLOR                   disable colors
  FORCE_COLOR                colors even when piped, same as --color always
  DO_NOT_TRACK               honored, as a no-op: this tool sends no telemetry, never phones home and never checks for updates

Files (mode 0600, never a key)
  .mepmail/migrate-state.json    ids created, resume cursors, plan hash
  .mepmail/migrate-report.json   the last run's report, also as migrate-report.md

Exit codes
  0 ok · 1 error · 2 plan has changes (plan only), or the MepMail API could not be reached (doctor/emails) · 3 partial, some items failed (details in the report)

${TRADEMARK_NOTICE}
`;
}
