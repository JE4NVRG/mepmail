import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

/**
 * A deliberately small IMAP4rev1 client for the migration assistant: LOGIN,
 * LIST, EXAMINE (read-only) and FETCH of a few header fields. It never reads a
 * message body, never writes to the remote account and only speaks TLS on 993.
 */
export type ImapFailure = "login" | "network" | "protocol" | "blocked";
export class ImapError extends Error {
  constructor(public readonly reason: ImapFailure) {
    super(reason);
  }
}

export interface ImapFolder {
  /** The raw (modified UTF-7) name used in commands. */
  name: string;
  /** The decoded name to show. */
  display: string;
  flags: string[];
}
export interface ImapHeaders {
  internalDate: Date | null;
  header: string;
}
export interface ImapSession {
  list(): Promise<ImapFolder[]>;
  examine(name: string): Promise<{ exists: number }>;
  /** Header fields of sequence numbers `from..to` (inclusive). */
  fetchHeaders(from: number, to: number, fields: readonly string[]): Promise<ImapHeaders[]>;
  logout(): Promise<void>;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function ipv4Public(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Only globally routable addresses: no loopback, private, link-local, CGNAT or documentation ranges. */
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4Public(ip);
  if (family !== 6) return false;
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped) return ipv4Public(mapped);
  return !(
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) ||
    /^fe[89ab]/.test(v6) ||
    /^ff/.test(v6) ||
    v6.startsWith("2001:db8:") ||
    v6.startsWith("64:ff9b:") ||
    v6.startsWith("100::")
  );
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * The account's server is user input: accept a public DNS name on port 993 and
 * pin the connection to an address checked here (no rebinding to the inside).
 */
export async function resolveImapEndpoint(
  host: string,
  port: number,
  resolve: Resolver = systemResolver,
): Promise<{ host: string; address: string }> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (
    port !== 993 ||
    !HOSTNAME.test(name) ||
    name.endsWith(".localhost") ||
    name.endsWith(".local")
  )
    throw new ImapError("blocked");
  let addresses: { address: string }[];
  try {
    addresses = await resolve(name);
  } catch {
    throw new ImapError("network");
  }
  if (!addresses.length) throw new ImapError("network");
  // Every answer must be public: one private answer would make the choice spoofable.
  if (!addresses.every((entry) => publicAddress(entry.address))) throw new ImapError("blocked");
  return { host: name, address: addresses[0]!.address };
}

interface Response {
  /** The response text; each literal is replaced by "\uE000<index>" (a private-use marker). */
  text: string;
  literals: Buffer[];
}

/** Modified UTF-7 (RFC 3501 5.1.3) to a display string. */
export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, chunk: string) => {
    if (!chunk) return "&";
    const bytes = Buffer.from(chunk.replace(/,/g, "/"), "base64");
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  });
}

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ImapError("protocol");
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function unquote(token: string): string {
  return token.slice(1, -1).replace(/\\(.)/g, "$1");
}

function parseInternalDate(value: string | undefined): Date | null {
  if (!value) return null;
  // "17-Jul-1996 02:44:25 -0700" -> "17 Jul 1996 02:44:25 -0700"
  const date = new Date(value.trim().replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3"));
  return Number.isNaN(date.getTime()) ? null : date;
}

class Session implements ImapSession {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private wake: (() => void) | null = null;
  private counter = 0;

  constructor(
    private readonly socket: Duplex,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    const end = () => {
      this.closed = true;
      this.wake?.();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  /** One complete response, with any literals it carries. */
  private parse(): Response | null {
    let offset = 0;
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const end = this.buffer.indexOf("\r\n", offset);
      if (end < 0) return null;
      const line = this.buffer.subarray(offset, end).toString("latin1");
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (!literal) {
        text += line;
        this.buffer = this.buffer.subarray(end + 2);
        return { text, literals };
      }
      const size = Number(literal[1]);
      if (size > 4 * 1024 * 1024) throw new ImapError("protocol");
      const start = end + 2;
      if (this.buffer.length < start + size) return null;
      text += `${line.slice(0, literal.index)}\uE000${literals.length}`;
      literals.push(Buffer.from(this.buffer.subarray(start, start + size)));
      offset = start + size;
    }
  }

  async read(): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const response = this.parse();
      if (response) return response;
      if (this.closed) throw new ImapError("network");
      const left = deadline - Date.now();
      if (left <= 0) throw new ImapError("network");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** Sends a command; Buffer parts are synchronizing literals. Returns the untagged responses. */
  async command(parts: (string | Buffer)[]): Promise<Response[]> {
    const tag = `A${++this.counter}`;
    const untagged: Response[] = [];
    let pending = [...parts];
    let chunk = `${tag} `;
    const flush = async () => {
      while (pending.length) {
        const part = pending.shift()!;
        if (typeof part === "string") {
          chunk += part;
          continue;
        }
        this.socket.write(`${chunk}{${part.length}}\r\n`, "latin1");
        chunk = "";
        for (;;) {
          const response = await this.read();
          if (response.text.startsWith("+")) break;
          if (response.text.startsWith(`${tag} `)) throw new ImapError("protocol");
          untagged.push(response);
        }
        this.socket.write(part);
      }
      this.socket.write(`${chunk}\r\n`, "latin1");
    };
    await flush();
    pending = [];
    for (;;) {
      const response = await this.read();
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1, tag.length + 4).toUpperCase();
        if (status === "OK ") return untagged;
        throw new ImapError(parts[0] === "LOGIN " ? "login" : "protocol");
      }
      if (response.text.startsWith("* BYE")) throw new ImapError("network");
      if (!response.text.startsWith("+")) untagged.push(response);
    }
  }

  async greet(): Promise<void> {
    const greeting = await this.read();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new ImapError("network");
  }

  async login(username: string, password: string): Promise<void> {
    await this.command(["LOGIN ", `${quote(username)} `, Buffer.from(password, "utf8")]);
  }

  async list(): Promise<ImapFolder[]> {
    const folders: ImapFolder[] = [];
    for (const response of await this.command(['LIST "" "*"'])) {
      const match = /^\* LIST \(([^)]*)\) (?:NIL|"(?:[^"\\]|\\.)*") (.+)$/i.exec(response.text);
      if (!match) continue;
      const raw = match[2]!.trim();
      const literal = /^\uE000(\d+)$/.exec(raw);
      const name = literal
        ? response.literals[Number(literal[1])]!.toString("utf8")
        : raw.startsWith('"')
          ? unquote(raw)
          : raw;
      folders.push({
        name,
        display: decodeMailboxName(name),
        flags: match[1]!
          .split(/\s+/)
          .filter(Boolean)
          .map((flag) => flag.toLowerCase()),
      });
    }
    return folders;
  }

  async examine(name: string): Promise<{ exists: number }> {
    let exists = 0;
    for (const response of await this.command([`EXAMINE ${quote(name)}`])) {
      const match = /^\* (\d+) EXISTS/i.exec(response.text);
      if (match) exists = Number(match[1]);
    }
    return { exists };
  }

  async fetchHeaders(from: number, to: number, fields: readonly string[]): Promise<ImapHeaders[]> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from)
      throw new ImapError("protocol");
    const items = `(INTERNALDATE BODY.PEEK[HEADER.FIELDS (${fields.join(" ")})])`;
    const out: ImapHeaders[] = [];
    for (const response of await this.command([`FETCH ${from}:${to} ${items}`])) {
      if (!/^\* \d+ FETCH /i.test(response.text)) continue;
      const date = /INTERNALDATE "([^"]+)"/i.exec(response.text)?.[1];
      const body = /BODY\[HEADER\.FIELDS [^\]]*\] (?:\uE000(\d+)|"((?:[^"\\]|\\.)*)"|NIL)/i.exec(
        response.text,
      );
      const header =
        body?.[1] !== undefined
          ? response.literals[Number(body[1])]!.toString("utf8")
          : body?.[2] !== undefined
            ? body[2]
            : "";
      out.push({ internalDate: parseInternalDate(date), header });
    }
    return out;
  }

  async logout(): Promise<void> {
    try {
      await this.command(["LOGOUT"]);
    } catch {
      /* the server may close first */
    } finally {
      this.socket.destroy();
    }
  }
}

export interface ImapOpenDeps {
  resolve?: Resolver;
  /** Opens the transport to a checked address; TLS with SNI and certificate checks by default. */
  connect?: (endpoint: { host: string; address: string; port: number }) => Duplex;
  timeoutMs?: number;
}

function tlsConnect(endpoint: { host: string; address: string; port: number }): Duplex {
  return tls.connect({
    host: endpoint.address,
    port: endpoint.port,
    servername: endpoint.host,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
}

/** Opens an authenticated session, or fails with login | network | protocol | blocked. */
export async function openImap(
  input: { host: string; port: number; username: string; password: string },
  deps: ImapOpenDeps = {},
): Promise<ImapSession> {
  const endpoint = await resolveImapEndpoint(input.host, input.port, deps.resolve);
  const socket = (deps.connect ?? tlsConnect)({ ...endpoint, port: input.port });
  const session = new Session(socket, deps.timeoutMs ?? 30_000);
  try {
    await session.greet();
    await session.login(input.username, input.password);
    return session;
  } catch (error) {
    socket.destroy();
    throw error instanceof ImapError ? error : new ImapError("network");
  }
}
