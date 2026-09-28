import type { Context } from "../context.js";
import {
  type EmailPageWire,
  type EmailSummaryWire,
  type EmailWire,
  hostOf,
  type Inspector,
  keyDryRunLabel,
  reportFailure,
} from "../inspect.js";
import { connectInspector, resolveTargetKey, resolveTargetUrl } from "../session.js";
import { column, dim, heading, layoutWidth, shortId } from "../theme.js";
import { pluralize, stripControl, truncate } from "../utils.js";

/** `2026-09-28T09:12:03.000Z` → `2026-09-28T09:12:03Z`; UTC, sortable, no guessing at a local zone. */
const stampOf = (iso: string): string => stripControl(iso.replace(/\.\d+(?=Z$)/, ""));

/** `delivered`, or `scheduled` when the row is still waiting for its due time. */
const eventOf = (email: EmailSummaryWire): string =>
  email.scheduled_at === null ? stripControl(email.last_event) : "scheduled";

/** Two lines per email: the copyable id above, who and what below. */
function row(email: EmailSummaryWire): string[] {
  const recipients =
    email.to.length > 1 ? `${email.to[0]} +${email.to.length - 1}` : (email.to[0] ?? "");
  const subject = stripControl(email.subject);
  return [
    `${dim(stampOf(email.created_at))} ${eventOf(email).padEnd(10)} ${email.id}`,
    `  ${truncate(`${stripControl(recipients)} · ${subject === "" ? "(no subject)" : subject}`, layoutWidth() - 2)}`,
  ];
}

async function list(ctx: Context, inspector: Inspector, baseUrl: string): Promise<number> {
  let page: EmailPageWire;
  try {
    page = await inspector.listEmails({
      limit: ctx.config.limit,
      after: ctx.config.after ?? undefined,
    });
  } catch (error) {
    return reportFailure(ctx, error, baseUrl);
  }
  if (ctx.config.json) {
    ctx.stdout.write(`${JSON.stringify(page)}\n`);
    return 0;
  }
  const { out } = ctx;
  if (page.data.length === 0) {
    out.write(
      `${dim("No emails")} on ${hostOf(baseUrl)}${ctx.config.after === null ? "" : " after that cursor"}.\n`,
    );
    out.write(
      `${dim("Send one through the API or the dashboard; `mepmail doctor` shows the account's limits.")}\n`,
    );
    return 0;
  }
  const title = `${pluralize(page.data.length, "email")}${page.has_more ? " (more available)" : ""} — ${hostOf(baseUrl)}`;
  out.write(`${heading(title)}\n`);
  for (const email of page.data) {
    for (const line of row(email)) out.write(`${line}\n`);
  }
  const last = page.data.at(-1);
  if (page.has_more && last !== undefined) {
    out.write(`\n${dim(`next page: mepmail emails list --after ${last.id}`)}\n`);
  }
  return 0;
}

async function get(ctx: Context, inspector: Inspector, baseUrl: string): Promise<number> {
  let email: EmailWire;
  try {
    email = await inspector.getEmail(ctx.config.emailId ?? "");
  } catch (error) {
    return reportFailure(ctx, error, baseUrl);
  }
  if (ctx.config.json) {
    ctx.stdout.write(`${JSON.stringify(email)}\n`);
    return 0;
  }
  const { out } = ctx;
  out.write(`${heading(`Email ${shortId(email.id)}`)}\n`);
  const rows: [string, string][] = [
    ["  To", stripControl(email.to.join(", "))],
    ["  From", stripControl(email.from)],
    ["  Subject", stripControl(email.subject)],
    ["  Created", stampOf(email.created_at)],
    ["  Event", eventOf(email)],
  ];
  if (email.scheduled_at !== null) rows.push(["  Scheduled", stampOf(email.scheduled_at)]);
  rows.push(["  Score", email.score === null ? dim("—") : String(email.score)]);
  if (email.message_id !== undefined) rows.push(["  Message-Id", stripControl(email.message_id)]);
  out.write(`${column(rows, 0).join("\n")}\n`);
  // The body is the point of `get`; the raw HTML only on request, since a
  // terminal is the wrong place to render a template.
  if (email.text !== null && email.text !== "") {
    out.write(`\n${heading("Text")}\n${stripControl(email.text)}\n`);
  } else if (email.html !== null && email.html !== "") {
    out.write(`\n${dim("HTML body only — pass --json for the raw HTML.")}\n`);
  } else {
    out.write(`\n${dim("No stored body: it was purged, or the email has not been sent yet.")}\n`);
  }
  return 0;
}

/** `--dry-run`: names the request and the host, calls nothing, uses no key. */
function dryRun(ctx: Context, baseUrl: string): number {
  const request =
    ctx.config.emailsAction === "get"
      ? `GET /emails/${ctx.config.emailId ?? "<id>"}`
      : `GET /emails?limit=${ctx.config.limit}${ctx.config.after === null ? "" : `&after=${ctx.config.after}`}`;
  if (ctx.config.json) {
    ctx.stdout.write(
      `${JSON.stringify({
        command: "emails",
        action: ctx.config.emailsAction,
        dry_run: true,
        url: baseUrl,
        key: keyDryRunLabel(ctx),
        request,
      })}\n`,
    );
    return 0;
  }
  ctx.out.write(`${heading("emails — dry run")}\n`);
  ctx.out.write(
    `${column(
      [
        ["  API", baseUrl],
        ["  Key", keyDryRunLabel(ctx)],
        ["  Request", request],
      ],
      0,
    ).join("\n")}\n`,
  );
  ctx.out.write(
    `\n${dim("Nothing was called: no request left this machine and the key was not used.")}\n`,
  );
  return 0;
}

/** `emails list` and `emails get`: the team's emails, oldest first, straight from the API. */
export async function emails(ctx: Context): Promise<number> {
  const baseUrl = await resolveTargetUrl(ctx);
  if (ctx.config.dryRun) return dryRun(ctx, baseUrl);
  const inspector = connectInspector(ctx, baseUrl, await resolveTargetKey(ctx));
  return ctx.config.emailsAction === "get"
    ? get(ctx, inspector, baseUrl)
    : list(ctx, inspector, baseUrl);
}
