import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImapError,
  imapTransientRefusal,
  openImap,
} from "../../../packages/core/src/mailbox-imap-client.js";

const PUBLIC = async () => [{ address: "203.0.114.10", family: 4 }];
const TRANSIENT = "NO User is authenticated but not connected.";

/**
 * A scripted Outlook.com: XOAUTH2 with an initial response; the first `refusals`
 * connections answer the transient "authenticated but not connected", later ones OK.
 * A LOGIN with a password always gets the transient refusal too (it must not retry).
 */
function fakeOutlook(options: { refusals: number; refusal?: string }) {
  const seen: string[] = [];
  let connections = 0;
  const server: Server = createServer((socket: Socket) => {
    const connection = ++connections;
    let buffer = "";
    socket.write("* OK The Microsoft Exchange IMAP4 service is ready.\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, command, mechanism, initial] = line.split(" ");
        if (command === "AUTHENTICATE" && mechanism === "XOAUTH2") {
          seen.push(
            Buffer.from(initial ?? "", "base64")
              .toString("utf8")
              .split("\x01")[0]!,
          );
          socket.write(
            connection <= options.refusals
              ? `${tag} ${options.refusal ?? TRANSIENT}\r\n`
              : `${tag} OK AUTHENTICATE completed.\r\n`,
          );
        } else if (command === "LOGIN") {
          socket.write("+ Ready for additional command text.\r\n");
          buffer = "";
          seen.push("LOGIN");
          setTimeout(() => socket.write(`${tag} ${TRANSIENT}\r\n`), 5);
        } else if (command === "LOGOUT") {
          socket.write(`* BYE Microsoft Exchange Server IMAP4 server signing off.\r\n`);
          socket.write(`${tag} OK LOGOUT completed.\r\n`);
          socket.end();
        }
      }
    });
  });
  return new Promise<{ server: Server; port: number; seen: string[]; connections: () => number }>(
    (resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve({
          server,
          port: typeof address === "object" && address ? address.port : 0,
          seen,
          connections: () => connections,
        });
      }),
  );
}

let running: Server | null = null;
afterEach(() => {
  running?.close();
  running = null;
});

async function signIn(
  fake: Awaited<ReturnType<typeof fakeOutlook>>,
  credential: { accessToken: string } | { password: string },
  extra: { transientRetries?: number } = {},
) {
  const pauses: number[] = [];
  const told: number[] = [];
  const session = await openImap(
    { host: "outlook.office365.com", port: 993, username: "jean@hotmail.test", ...credential },
    {
      resolve: PUBLIC,
      connect: () => tcpConnect(fake.port, "127.0.0.1"),
      timeoutMs: 5000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
      onTransientRefusal: (attempt) => told.push(attempt),
      ...extra,
    },
  );
  return { session, pauses, told };
}

describe("Outlook.com transient XOAUTH2 refusal", () => {
  it("tries a fresh connection until Outlook.com lets the token in", async () => {
    const fake = await fakeOutlook({ refusals: 3 });
    running = fake.server;
    const { session, pauses, told } = await signIn(fake, { accessToken: "token-fake" });
    await session.logout();
    expect(fake.connections()).toBe(4);
    expect(fake.seen).toEqual(Array(4).fill("user=jean@hotmail.test"));
    expect(told).toEqual([1, 2, 3]);
    expect(pauses).toEqual([1000, 1000, 1000]);
  });

  it("gives up after the retries with the provider's words", async () => {
    const fake = await fakeOutlook({ refusals: 99 });
    running = fake.server;
    const failure = await signIn(
      fake,
      { accessToken: "token-fake" },
      { transientRetries: 2 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImapError);
    expect((failure as ImapError).reason).toBe("login");
    expect((failure as ImapError).detail).toContain("authenticated but not connected");
    expect(imapTransientRefusal(failure)).toBe(true);
    expect(fake.connections()).toBe(3);
  });

  it("does not retry a refused token", async () => {
    const fake = await fakeOutlook({ refusals: 99, refusal: "NO AUTHENTICATE failed." });
    running = fake.server;
    const failure = await signIn(fake, { accessToken: "token-fake" }).catch(
      (error: unknown) => error,
    );
    expect((failure as ImapError).reason).toBe("login");
    expect(imapTransientRefusal(failure)).toBe(false);
    expect(fake.connections()).toBe(1);
  });

  it("does not retry a password sign-in", async () => {
    const fake = await fakeOutlook({ refusals: 99 });
    running = fake.server;
    const failure = await signIn(fake, { password: "app-password-fake" }).catch(
      (error: unknown) => error,
    );
    expect((failure as ImapError).reason).toBe("login");
    expect(fake.connections()).toBe(1);
  });
});
