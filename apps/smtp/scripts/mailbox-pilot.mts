import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MailboxPilotError, type MailboxActor } from "../../../packages/core/src/mailbox-pilot.js";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { agent, human, openPilot, seedPilot } from "../test/mailbox-pilot-fixture.js";

// Explicitly local, synthetic identities. This is not production authentication.
if (process.env.MEPMAIL_LOCAL_PILOT !== "1" || process.env.NODE_ENV !== "test") {
  throw new Error("The mailbox qualification runner requires the local fixture environment");
}
const origin = "http://127.0.0.1:3186";
const port = Number(process.env.MEPMAIL_LOCAL_PILOT_PORT ?? "3186");
if (port !== 3186 && port !== 3000) throw new Error("Unsupported local pilot port");
const storage = join(tmpdir(), "mepmail-mailbox-pilot");
await mkdir(storage, { recursive: true, mode: 0o700 });
const keyFile = join(storage, "fixture-key.private");
let keyBytes: Buffer;
try {
  keyBytes = await readFile(keyFile);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  keyBytes = randomBytes(32);
  await writeFile(keyFile, keyBytes, { flag: "wx", mode: 0o600 });
}
const key = EnvKeyring.fromBase64(keyBytes.toString("base64"));
keyBytes.fill(0);
const file = join(storage, "state.enc.json");
let service = await openPilot(file, key);
await seedPilot(service);
const html = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "mailbox-pilot.html"),
  "utf8",
);
const sessions = new Map<string, "human" | "agent">();
const captures = new Set<string>();
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutations.then(operation);
  mutations = next.catch(() => undefined);
  return next;
}

function session(req: IncomingMessage, res: ServerResponse) {
  const token = (req.headers.cookie ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("mailbox_pilot="))
    ?.slice(14);
  if (token && sessions.has(token)) return token;
  const fresh = randomBytes(32).toString("hex");
  sessions.set(fresh, "human");
  res.setHeader("Set-Cookie", `mailbox_pilot=${fresh}; Path=/; HttpOnly; SameSite=Strict`);
  return fresh;
}
function send(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    req.headers.origin !== origin ||
    req.headers["x-mailbox-pilot"] !== "1" ||
    req.headers["content-type"] !== "application/json"
  ) {
    throw new MailboxPilotError("forbidden");
  }
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new MailboxPilotError("too_large");
    parts.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MailboxPilotError("invalid");
  return value as Record<string, unknown>;
}
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const nonce = randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  );
  try {
    if (req.headers.host !== "127.0.0.1:3186" || (req.url?.length ?? 0) > 1024)
      throw new MailboxPilotError("forbidden");
    const url = new URL(req.url ?? "/", origin);
    const token = session(req, res);
    const mode = sessions.get(token)!;
    const actor: MailboxActor = mode === "agent" ? agent : human;
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html.replaceAll("__NONCE__", nonce));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/mailboxes") {
      const mailboxes = await service.mailboxes(actor);
      const counts = await Promise.all(
        mailboxes.map(
          async (box) =>
            (await service.list(actor, box.id)).filter((message) => message.folder === "sent")
              .length,
        ),
      );
      send(res, { mode, mailboxes, captured: counts.reduce((sum, count) => sum + count, 0) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const input = await body(req);
      if (input.mode !== "human" && input.mode !== "agent") throw new MailboxPilotError("invalid");
      sessions.set(token, input.mode);
      send(res, { mode: input.mode });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reopen") {
      await body(req);
      if (mode !== "human") throw new MailboxPilotError("forbidden");
      // Load the encrypted snapshot again, preserving the fixture key and grants.
      await mutate(async () => {
        service = await openPilot(file, key);
      });
      send(res, { restored: true });
      return;
    }
    const route =
      /^\/api\/mailboxes\/([a-z]+)\/(messages|drafts)(?:\/([a-z0-9-]+))?(?:\/(reply|send|attachments)(?:\/(\d+))?)?$/.exec(
        url.pathname,
      );
    if (!route) throw new MailboxPilotError("not_found");
    const [, mailbox, collection, id, action, attachmentId] = route;
    if (req.method === "GET" && !id) {
      send(
        res,
        collection === "messages"
          ? await service.list(actor, mailbox)
          : await service.drafts(actor, mailbox),
      );
      return;
    }
    if (req.method === "GET" && collection === "messages" && id && !action) {
      send(res, await service.read(actor, mailbox, id));
      return;
    }
    if (
      req.method === "GET" &&
      collection === "messages" &&
      id &&
      action === "attachments" &&
      attachmentId
    ) {
      const attachment = await service.attachment(actor, mailbox, id, Number(attachmentId));
      const name =
        attachment.filename.replaceAll(/[\/\\\r\n\x00-\x1f]/g, "_").slice(0, 128) || "anexo";
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attachment.bin"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      res.end(attachment.content);
      return;
    }
    if (req.method === "POST" && collection === "messages" && id && action === "reply") {
      const input = await body(req);
      if (
        typeof input.text !== "string" ||
        !Array.isArray(input.attachments) ||
        !input.attachments.every((value) => typeof value === "number")
      )
        throw new MailboxPilotError("invalid");
      const text = input.text;
      const attachments = input.attachments as number[];
      send(res, await mutate(() => service.reply(actor, mailbox, id, text, attachments)));
      return;
    }
    if (req.method === "POST" && collection === "drafts" && id && action === "send") {
      await body(req);
      send(
        res,
        await mutate(() =>
          service.send(actor, mailbox, id, async ({ idempotencyKey }) => {
            // No SMTP, SES or external transport; idempotent in-memory capture only.
            captures.add(idempotencyKey);
          }),
        ),
      );
      return;
    }
    throw new MailboxPilotError("not_found");
  } catch (error) {
    const code = error instanceof MailboxPilotError ? error.code : "invalid";
    send(
      res,
      { error: code },
      code === "forbidden" ? 403 : code === "not_found" ? 404 : code === "too_large" ? 413 : 400,
    );
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, port === 3000 ? "0.0.0.0" : "127.0.0.1", () =>
  console.log("MepMail local mailbox pilot ready; synthetic fixtures only"),
);
