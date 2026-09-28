import { TARGET_KEY_ENV } from "../config.js";
import type { Context } from "../context.js";
import { ApiError } from "../http.js";
import {
  API_FAILURE_EXIT,
  apiFailureHint,
  type DeliverabilityWire,
  type DomainWire,
  keyDryRunLabel,
  keySourceLabel,
  type UsageWire,
} from "../inspect.js";
import { VERSION } from "../meta.js";
import { connectInspector, resolveTargetKey, resolveTargetUrl } from "../session.js";
import {
  bold,
  column,
  dim,
  err,
  heading,
  layoutWidth,
  ok,
  SYM,
  warn,
  wrapIndent,
} from "../theme.js";
import { capitalize, formatNumber, pluralize, stripControl, truncate } from "../utils.js";

type CheckStatus = "ok" | "warn" | "fail";
type CheckId = "cli" | "key" | "api" | "auth" | "domains" | "sending";

interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  /** The one thing to do about a warn/fail. */
  hint?: string;
}

const MARK: Record<CheckStatus, string> = {
  ok: ok(SYM.ok),
  warn: warn(SYM.note),
  fail: err(SYM.err),
};

/** Checks that only run once the one before them answered, in the order they run. */
const GATED: readonly CheckId[] = ["api", "auth", "domains", "sending"];

/** The shape @millionsend/core mints (`ms_` + url-safe secret); checked, never printed. */
const KEY_SHAPE_RE = /^ms_[A-Za-z0-9_-]{6,}$/;

const messageOf = (error: unknown): string =>
  stripControl(error instanceof Error ? error.message : String(error));

const revisionOf = (revision: string | null | undefined): string =>
  revision === null || revision === undefined || revision === ""
    ? "unknown"
    : stripControl(truncate(revision, 12));

const percent = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(2)}%`;

/** Where the key comes from, so a wrong env var is visible without printing the key. */
function keyCheck(ctx: Context, token: string): Check {
  const where = keySourceLabel(ctx.config.toKey.source);
  if (KEY_SHAPE_RE.test(token)) {
    return { id: "key", label: "Key", status: "ok", detail: `${where} · full-access shape (ms_…)` };
  }
  return {
    id: "key",
    label: "Key",
    status: "warn",
    detail: `${where} · the value has no ms_… shape`,
    hint: `a MepMail API key starts with ms_; this looks like another provider's key. Point ${TARGET_KEY_ENV} at the instance's full-access key.`,
  };
}

function authDetail(usage: UsageWire): string {
  const parts = [
    usage.cloud ? `plan ${capitalize(usage.plan ?? "unknown")}` : "self-hosted instance",
    usage.limits.emails_per_day === null
      ? `${formatNumber(usage.today.emails_sent)} emails today`
      : `${formatNumber(usage.today.emails_sent)} of ${formatNumber(usage.limits.emails_per_day)} emails today`,
  ];
  const team = usage.team?.name;
  if (team !== undefined && team !== "") parts.push(`team ${stripControl(team)}`);
  return parts.join(" · ");
}

/** Verified vs pending/failed domains, naming the pending ones. */
function domainCheck(domains: DomainWire[]): Check {
  if (domains.length === 0) {
    return {
      id: "domains",
      label: "Domains",
      status: "warn",
      detail: "no sending domain yet",
      hint: "add a domain in the dashboard (Domains → Add domain) and publish its DNS records; nothing can be sent until one is verified.",
    };
  }
  const verified = domains.filter((d) => d.status === "verified");
  const rest = domains.filter((d) => d.status !== "verified");
  if (rest.length === 0) {
    return {
      id: "domains",
      label: "Domains",
      status: "ok",
      detail: `${pluralize(verified.length, "domain")} verified`,
    };
  }
  const named = rest.map((d) => `${stripControl(d.name)} (${stripControl(d.status)})`);
  const extra = named.length > 3 ? ` +${named.length - 3} more` : "";
  return {
    id: "domains",
    label: "Domains",
    status: "warn",
    detail: `${pluralize(verified.length, "domain")} verified · ${pluralize(rest.length, "domain")} pending: ${named.slice(0, 3).join(", ")}${extra}`,
    hint: "publish the DNS records of the pending domains (dashboard → Domains → the domain); sending from them is refused until they verify.",
  };
}

/** The deliverability guardrail: the `sending_paused` state lives here. */
function sendingCheck(deliverability: DeliverabilityWire): Check {
  const rates = `bounce ${percent(deliverability.hard_bounce_rate)} · complaints ${percent(deliverability.complaint_rate)}`;
  const score = deliverability.score === null ? "" : ` · score ${deliverability.score}`;
  if (deliverability.guardrail_status === "paused") {
    return {
      id: "sending",
      label: "Sending",
      status: "warn",
      detail: `paused — the API refuses sends with 403 sending_paused${score} · ${rates}`,
      hint: "lower the bounce/complaint rate before sending again (clean the list, never retry a hard bounce); the guardrail lifts on its own as the window improves.",
    };
  }
  if (deliverability.guardrail_status === "warning") {
    return {
      id: "sending",
      label: "Sending",
      status: "warn",
      detail: `guardrail warning${score} · ${rates}`,
      hint: "close to the pause threshold: clean the list before the next campaign.",
    };
  }
  return {
    id: "sending",
    label: "Sending",
    status: "ok",
    detail: `guardrail ok${score} · ${rates}`,
  };
}

function printChecks(ctx: Context, checks: Check[], skipped: readonly CheckId[]): void {
  const width = Math.max(0, ...checks.map((c) => c.label.length));
  for (const check of checks) {
    ctx.out.write(
      `${truncate(`${MARK[check.status]} ${check.label.padEnd(width)}  ${check.detail}`, layoutWidth())}\n`,
    );
    if (check.hint !== undefined) {
      const pad = " ".repeat(width + 5);
      ctx.out.write(`${wrapIndent(dim(`→ ${check.hint}`), { indent: pad, hanging: pad })}\n`);
    }
  }
  if (skipped.length > 0) {
    ctx.out.write(`${dim(`− ${skipped.join(", ")} skipped until the line above passes`)}\n`);
  }
}

function verdict(checks: readonly Check[], exitCode: number): string {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  if (failed > 0) {
    return `${err(SYM.err)} ${pluralize(failed, "check")} failed — fix the hints above (exit ${exitCode}).`;
  }
  if (warned > 0)
    return `${warn(SYM.note)} ${pluralize(warned, "warning")} — nothing blocking; see the hints above.`;
  return `${ok(SYM.ok)} Everything checks out.`;
}

/** `--dry-run`: names the requests and the host, calls nothing, uses no key. */
function dryRun(ctx: Context, baseUrl: string): number {
  const requests = ["GET /health", "GET /usage", "GET /domains", "GET /deliverability"];
  if (ctx.config.json) {
    ctx.stdout.write(
      `${JSON.stringify({ command: "doctor", dry_run: true, url: baseUrl, key: keyDryRunLabel(ctx), requests })}\n`,
    );
    return 0;
  }
  ctx.out.write(`${heading("doctor — dry run")}\n`);
  ctx.out.write(
    `${column(
      [
        ["  API", baseUrl],
        ["  Key", keyDryRunLabel(ctx)],
        ["  Requests", requests.join(" · ")],
      ],
      0,
    ).join("\n")}\n`,
  );
  ctx.out.write(
    `\n${dim("Nothing was called: no request left this machine and the key was not used.")}\n`,
  );
  return 0;
}

/**
 * What a working MepMail setup needs, in order: CLI, key, reachable API, key
 * accepted, domains, sending guardrail. Exit 0 when only warnings remain, 1
 * when the key/arguments are unusable, 2 when the API could not be reached.
 */
export async function doctor(ctx: Context): Promise<number> {
  const baseUrl = await resolveTargetUrl(ctx);
  if (ctx.config.dryRun) return dryRun(ctx, baseUrl);

  let exitCode = 0;
  const fail = (code: number): void => {
    exitCode = Math.max(exitCode, code);
  };
  const checks: Check[] = [
    {
      id: "cli",
      label: "CLI",
      status: "ok",
      detail: `mepmail ${VERSION} · node ${process.version}`,
    },
  ];

  // Resolved once, kept in memory: the value never reaches an output stream.
  let token: string | null = null;
  let keyError = "";
  try {
    token = await resolveTargetKey(ctx);
  } catch (error) {
    keyError = messageOf(error);
  }
  if (token === null) {
    fail(1);
    checks.push({
      id: "key",
      label: "Key",
      status: "fail",
      detail: keyError,
      hint: `set ${TARGET_KEY_ENV}, or pass --to-key-stdin / --to-key (a non-interactive run never prompts).`,
    });
  } else {
    checks.push(keyCheck(ctx, token));
  }

  if (token !== null) {
    const inspector = connectInspector(ctx, baseUrl, token);
    let connected = true;

    // The API is asked for /health first: a broken host must not be reported as a broken key.
    const started = Date.now();
    try {
      const health = await inspector.health();
      const healthy = health.status === "ok";
      checks.push({
        id: "api",
        label: "API",
        status: healthy ? "ok" : "warn",
        detail: `${baseUrl} reachable · ${Date.now() - started} ms · revision ${revisionOf(health.revision)}`,
        ...(healthy
          ? {}
          : {
              hint: "the instance answered something other than ok; check its logs (docker compose logs api).",
            }),
      });
    } catch (error) {
      connected = false;
      fail(API_FAILURE_EXIT);
      checks.push({
        id: "api",
        label: "API",
        status: "fail",
        detail: `${baseUrl} — ${messageOf(error)}`,
        hint: apiFailureHint(error, baseUrl),
      });
    }

    if (connected) {
      try {
        checks.push({
          id: "auth",
          label: "Auth",
          status: "ok",
          detail: authDetail(await inspector.usage()),
        });
      } catch (error) {
        connected = false;
        fail(API_FAILURE_EXIT);
        checks.push({
          id: "auth",
          label: "Auth",
          status: "fail",
          detail: messageOf(error),
          hint: apiFailureHint(error, baseUrl),
        });
      }
    }

    if (connected) {
      try {
        checks.push(domainCheck(await inspector.domains()));
      } catch (error) {
        fail(API_FAILURE_EXIT);
        checks.push({
          id: "domains",
          label: "Domains",
          status: "fail",
          detail: messageOf(error),
          hint: apiFailureHint(error, baseUrl),
        });
      }
      try {
        checks.push(sendingCheck(await inspector.deliverability()));
      } catch (error) {
        const missing = error instanceof ApiError && error.status === 404;
        if (!missing) fail(API_FAILURE_EXIT);
        checks.push({
          id: "sending",
          label: "Sending",
          status: missing ? "warn" : "fail",
          detail: messageOf(error),
          hint: missing
            ? "this instance has no GET /deliverability (an older build): the sending guardrail cannot be read here."
            : apiFailureHint(error, baseUrl),
        });
      }
    }
  }

  const done = new Set(checks.map((c) => c.id));
  // Each skipped check is named once, in the order it would have run.
  const skipped = GATED.filter((id) => !done.has(id));

  if (ctx.config.json) {
    ctx.stdout.write(
      `${JSON.stringify({
        command: "doctor",
        version: VERSION,
        node: process.version,
        url: baseUrl,
        ok: exitCode === 0,
        checks,
        skipped,
      })}\n`,
    );
  } else {
    ctx.out.write(`${bold(`mepmail doctor — ${VERSION}`)}\n\n`);
    printChecks(ctx, checks, skipped);
    ctx.out.write(`\n${verdict(checks, exitCode)}\n`);
  }
  return exitCode;
}
