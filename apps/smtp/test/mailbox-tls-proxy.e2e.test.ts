import { readFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailboxImapServer } from "../src/imap/server.js";
import { createMailboxSubmissionServer } from "../src/mailbox-submission.js";

/**
 * The mail-app servers exactly as production starts them: TLS (993, 465) or STARTTLS
 * (587), behind the host's nginx stream proxy, so every connection starts with a PROXY v1
 * line and then TLS. 0.133's first cutover failed here (imap-core's TLS-from-the-first-
 * byte path needed an SNICallback); the plain-loopback e2e never took this path.
 * No database: greetings, CAPABILITY and EHLO happen before any sign-in.
 * test/fixtures/tls-test.* is a self-signed pair for localhost only (CN and SAN
 * localhost, 127.0.0.1), made for these tests; it names no real host.
 */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const keypair = { cert: fixture("tls-test.crt"), key: fixture("tls-test.key") };
const stub = null as never;
const proxyLine = (port: number) => `PROXY TCP4 203.0.113.7 127.0.0.1 51234 ${port}\r\n`;

function until(
  stream: net.Socket | tls.TLSSocket,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`timeout; got: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(buffer);
      }
    };
    stream.on("data", onData);
    stream.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectRaw(port: number) {
  const raw = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    raw.once("connect", resolve);
    raw.once("error", reject);
  });
  raw.write(proxyLine(port));
  return raw;
}

async function startTls(
  socket: net.Socket,
  servername: string,
  options: tls.ConnectionOptions = {},
) {
  const secure = tls.connect({ socket, servername, ca: keypair.cert, ...options });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return secure;
}

const servers: { close(callback?: () => void): void }[] = [];
let imapPort: number;
let tlsPort: number;
let starttlsPort: number;

beforeAll(async () => {
  const imap = createMailboxImapServer({
    db: stub,
    keyring: stub,
    passwordKey: Buffer.alloc(32),
    tls: keypair,
    secure: true,
    proxyProtocol: true,
  });
  await new Promise<void>((resolve) => imap.listen(0, "127.0.0.1", resolve));
  imapPort = (imap.server.address() as AddressInfo).port;
  servers.push(imap);
  const submission = (secure: boolean) =>
    createMailboxSubmissionServer({
      db: stub,
      keyring: stub,
      passwordKey: Buffer.alloc(32),
      mime: stub,
      enqueueSend: async () => {},
      transportEnabled: true,
      tls: keypair,
      secure,
      proxyProtocol: true,
    });
  for (const secure of [true, false]) {
    const server = submission(secure);
    // Refused handshakes (the TLS 1.1 check) are reported here, as server.ts logs them.
    server.on("error", () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as AddressInfo).port;
    if (secure) tlsPort = port;
    else starttlsPort = port;
    servers.push(server);
  }
});
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A client that would settle for TLS 1.1 (security level 0 so the client side allows it). */
const tls11 = {
  maxVersion: "TLSv1.1",
  minVersion: "TLSv1",
  ciphers: "DEFAULT:@SECLEVEL=0",
} as const;

describe("behind the host's proxy, with real TLS", () => {
  it("IMAP on 993 answers after the PROXY line and TLS from the first byte", async () => {
    const secure = await startTls(await connectRaw(imapPort), "localhost");
    expect(secure.authorized).toBe(true);
    expect(await until(secure, /^\* OK/m)).toMatch(/^\* OK/m);
    secure.write("A1 CAPABILITY\r\n");
    const capability = await until(secure, /^A1 OK/m);
    expect(capability).toMatch(/IMAP4rev1/);
    expect(capability).toMatch(/AUTH=PLAIN/);
    expect(capability).not.toMatch(/CONDSTORE|QUOTA|STARTTLS/);
    secure.destroy();
  });

  it("submission on 465 answers after the PROXY line and TLS from the first byte", async () => {
    const secure = await startTls(await connectRaw(tlsPort), "localhost");
    expect(await until(secure, /^220 /m)).toMatch(/^220 smtp\.mepmail\.dev/m);
    secure.write("EHLO client.example\r\n");
    expect(await until(secure, /^250 /m)).toMatch(/AUTH PLAIN LOGIN/);
    secure.destroy();
  });

  it("submission on 587 answers after the PROXY line, upgrades with STARTTLS and offers AUTH", async () => {
    const raw = await connectRaw(starttlsPort);
    expect(await until(raw, /^220 /m)).toMatch(/^220 smtp\.mepmail\.dev/m);
    raw.write("EHLO client.example\r\n");
    const before = await until(raw, /^250 /m);
    expect(before).toMatch(/STARTTLS/);
    raw.write("STARTTLS\r\n");
    await until(raw, /^220 /m);
    const secure = await startTls(raw, "localhost");
    secure.write("EHLO client.example\r\n");
    expect(await until(secure, /^250 /m)).toMatch(/AUTH PLAIN LOGIN/);
    secure.destroy();
  });

  it("refuses TLS older than 1.2 on 993, 465 and 587", async () => {
    await expect(startTls(await connectRaw(imapPort), "localhost", tls11)).rejects.toThrow();
    await expect(startTls(await connectRaw(tlsPort), "localhost", tls11)).rejects.toThrow();
    const raw = await connectRaw(starttlsPort);
    await until(raw, /^220 /m);
    raw.write("EHLO client.example\r\n");
    await until(raw, /^250 /m);
    raw.write("STARTTLS\r\n");
    await until(raw, /^220 /m);
    await expect(startTls(raw, "localhost", tls11)).rejects.toThrow();
    // And what a mail app gets: TLS 1.2 or 1.3.
    const modern = await startTls(await connectRaw(imapPort), "localhost");
    expect(["TLSv1.2", "TLSv1.3"]).toContain(modern.getProtocol());
    modern.destroy();
  });
});
