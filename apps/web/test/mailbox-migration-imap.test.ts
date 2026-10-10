import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeMailboxName,
  ImapError,
  type ImapSession,
  openImap,
  publicAddress,
  resolveImapEndpoint,
} from "@/server/mailbox-migration/imap";
import {
  headerFields,
  scanAccount,
  scannableFolders,
  sentFolder,
} from "@/server/mailbox-migration/scan";

const PUBLIC = async () => [{ address: "203.0.114.10", family: 4 }];

/** A scripted IMAP server: greets, takes LOGIN with a synchronizing literal, answers LIST/EXAMINE/FETCH. */
function fakeServer(options: { password?: string } = {}) {
  const password = options.password ?? "s3cret pass";
  const seen: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let awaitingLiteral: { tag: string; user: string; size: number } | null = null;
    socket.write("* OK fake IMAP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (awaitingLiteral) {
          if (Buffer.byteLength(buffer) < awaitingLiteral.size + 2) return;
          const literal = buffer.slice(0, awaitingLiteral.size);
          buffer = buffer.slice(awaitingLiteral.size + 2);
          const { tag } = awaitingLiteral;
          awaitingLiteral = null;
          socket.write(
            literal === password
              ? `${tag} OK LOGIN done\r\n`
              : `${tag} NO [AUTHENTICATIONFAILED] bad\r\n`,
          );
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        seen.push(line.replace(/\{\d+\}$/, "{literal}"));
        const [tag, command] = line.split(" ", 2);
        const login = /^(\S+) LOGIN "((?:[^"\\]|\\.)*)" \{(\d+)\}$/.exec(line);
        if (login) {
          awaitingLiteral = { tag: login[1]!, user: login[2]!, size: Number(login[3]) };
          socket.write("+ go ahead\r\n");
        } else if (command === "LIST") {
          socket.write('* LIST (\\HasNoChildren) "/" INBOX\r\n');
          socket.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"\r\n');
          socket.write('* LIST (\\HasNoChildren \\Trash) "/" Trash\r\n');
          socket.write('* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"\r\n');
          socket.write('* LIST (\\HasNoChildren) "/" {11}\r\nCaixa &AOk-\r\n');
          socket.write(`${tag} OK LIST done\r\n`);
        } else if (command === "EXAMINE") {
          socket.write(
            `* ${line.includes("INBOX") ? 3 : 1} EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT 13] ok\r\n${tag} OK [READ-ONLY] done\r\n`,
          );
        } else if (command === "UID" && /^\S+ UID SEARCH UID \d+:\*$/.test(line)) {
          // Like real servers, "n:*" still answers the highest UID when n is past it.
          socket.write(`* SEARCH 10 11 12\r\n${tag} OK SEARCH done\r\n`);
        } else if (
          command === "UID" &&
          / UID FETCH [\d,]+ \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)$/.test(line)
        ) {
          const uids = / UID FETCH ([\d,]+) /.exec(line)![1]!.split(",").map(Number);
          for (const [index, uid] of uids.entries()) {
            const raw = `From: ana@piloto.test\r\nSubject: Message ${uid}\r\n\r\nBody of ${uid}\r\n`;
            const flags = uid === 10 ? "\\Seen" : "";
            socket.write(
              `* ${index + 1} FETCH (UID ${uid} FLAGS (${flags}) INTERNALDATE "0${index + 1}-Mar-2025 10:00:00 +0000" BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`,
            );
          }
          socket.write(`${tag} OK FETCH done\r\n`);
        } else if (command === "FETCH") {
          const header =
            "To: Ana <ana@piloto.test>, outside@else.example\r\nDelivered-To: contato@piloto.test\r\n\r\n";
          const size = Buffer.byteLength(header);
          socket.write(
            `* 1 FETCH (INTERNALDATE "17-Jul-2026 02:44:25 -0300" BODY[HEADER.FIELDS (TO CC)] {${size}}\r\n${header})\r\n`,
          );
          socket.write(`${tag} OK FETCH done\r\n`);
        } else if (command === "LOGOUT") {
          socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        } else socket.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise<{ server: Server; port: number; seen: string[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, seen });
    }),
  );
}

let running: Server | null = null;
afterEach(() => {
  running?.close();
  running = null;
});

async function open(password = "s3cret pass") {
  const fake = await fakeServer();
  running = fake.server;
  const session = await openImap(
    { host: "imap.piloto.test.example", port: 993, username: "jean@piloto.test", password },
    { resolve: PUBLIC, connect: () => tcpConnect(fake.port, "127.0.0.1"), timeoutMs: 5000 },
  );
  return { session, seen: fake.seen };
}

describe("migration IMAP client", () => {
  it("logs in with a literal password, lists folders and reads only header fields", async () => {
    const { session, seen } = await open();
    const folders = await session.list();
    expect(folders.map((f) => f.display)).toEqual([
      "INBOX",
      "Sent Items",
      "Trash",
      "[Gmail]",
      "Caixa é",
    ]);
    expect(scannableFolders(folders).map((f) => f.display)).toEqual([
      "INBOX",
      "Sent Items",
      "Caixa é",
    ]);
    expect(sentFolder(folders[1]!)).toBe(true);
    expect(await session.examine("INBOX")).toEqual({ exists: 3, uidValidity: 777, uidNext: 13 });
    const [message] = await session.fetchHeaders(1, 3, ["TO", "CC"]);
    expect(message?.internalDate?.toISOString()).toBe("2026-07-17T05:44:25.000Z");
    expect(message?.header).toContain("Delivered-To: contato@piloto.test");
    await session.logout();
    expect(seen.find((line) => line.includes("LOGIN"))).toBe(
      'A1 LOGIN "jean@piloto.test" {literal}',
    );
    expect(seen.some((line) => line.includes("s3cret"))).toBe(false);
    expect(seen.find((line) => line.includes("FETCH"))).toContain(
      "BODY.PEEK[HEADER.FIELDS (TO CC)]",
    );
  });
  it("lists UIDs after a cursor and fetches whole messages read-only, with flags and dates", async () => {
    const { session, seen } = await open();
    await session.examine("INBOX");
    expect(await session.uidSearchAfter(9)).toEqual([10, 11, 12]);
    // Past the last UID the server still answers it; the client drops it.
    expect(await session.uidSearchAfter(12)).toEqual([]);
    const messages = await session.uidFetchMessages([10, 11]);
    expect(messages.map((m) => [m.uid, m.flags, m.internalDate?.toISOString()])).toEqual([
      [10, ["\\seen"], "2025-03-01T10:00:00.000Z"],
      [11, [], "2025-03-02T10:00:00.000Z"],
    ]);
    expect(messages[1]?.raw.toString()).toContain("Body of 11");
    await session.logout();
    expect(seen.find((line) => line.includes("UID FETCH"))).toContain("BODY.PEEK[]");
    expect(seen.some((line) => /\bSTORE\b|\bEXPUNGE\b|\bSELECT\b/.test(line))).toBe(false);
  });
  it("reports a rejected password as login", async () => {
    await expect(open("wrong")).rejects.toMatchObject({ reason: "login" });
  });
  it("refuses private, loopback and non-993 endpoints before connecting", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.20.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ["203.0.114.10", "8.8.8.8", "2606:4700::1111"])
      expect(publicAddress(ip), ip).toBe(true);
    const privateAnswer = async () => [
      { address: "203.0.114.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(resolveImapEndpoint("imap.example.com", 993, privateAnswer)).rejects.toMatchObject(
      { reason: "blocked" },
    );
    await expect(resolveImapEndpoint("imap.example.com", 143, PUBLIC)).rejects.toMatchObject({
      reason: "blocked",
    });
    for (const host of ["127.0.0.1", "localhost", "intranet", "printer.local", "x.localhost"])
      await expect(resolveImapEndpoint(host, 993, PUBLIC), host).rejects.toBeInstanceOf(ImapError);
    expect(await resolveImapEndpoint("IMAP.PurelyMail.com.", 993, PUBLIC)).toEqual({
      host: "imap.purelymail.com",
      address: "203.0.114.10",
    });
  });
  it("decodes modified UTF-7 folder names", () => {
    expect(decodeMailboxName("Itens &AOk-nviados")).toBe("Itens énviados");
    expect(decodeMailboxName("A &- B")).toBe("A & B");
  });
});

describe("migration header scan", () => {
  function session(
    folders: Record<string, { header: string; date: string }[]>,
    flags: Record<string, string[]> = {},
  ): ImapSession {
    let current = "";
    return {
      list: async () =>
        Object.keys(folders).map((name) => ({ name, display: name, flags: flags[name] ?? [] })),
      examine: async (name) => {
        current = name;
        return { exists: folders[name]!.length };
      },
      fetchHeaders: async (from, to) =>
        folders[current]!.slice(from - 1, to).map((m) => ({
          header: m.header,
          internalDate: new Date(m.date),
        })),
      logout: async () => {},
    };
  }
  it("counts own-domain recipients, keeps other domains as totals, and reads From only in Sent", async () => {
    const result = await scanAccount(
      session(
        {
          INBOX: [
            { header: "To: jean@piloto.test\r\nCc: someone@gmail.example\r\n", date: "2026-01-01" },
            {
              header: "Delivered-To: suporte@piloto.test\r\nTo: list@else.example\r\n",
              date: "2026-05-01",
            },
            {
              header: "X-Original-To: Suporte@Piloto.test\r\nFrom: stranger@piloto.test\r\n",
              date: "2026-03-01",
            },
          ],
          Sent: [
            {
              header: "From: vendas@piloto.test\r\nTo: client@gmail.example\r\n",
              date: "2026-06-01",
            },
          ],
        },
        { Sent: ["\\sent"] },
      ),
      { ownDomains: new Set(["piloto.test"]), batchSize: 2 },
    );
    expect(Object.fromEntries([...result.addresses].map(([a, e]) => [a, e.messages]))).toEqual({
      "jean@piloto.test": 1,
      "suporte@piloto.test": 2,
      "vendas@piloto.test": 1,
    });
    expect(result.addresses.get("suporte@piloto.test")?.lastSeenAt?.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(Object.fromEntries(result.external)).toEqual({ "gmail.example": 2, "else.example": 1 });
    expect(result).toMatchObject({
      messagesSeen: 4,
      foldersDone: 2,
      foldersTotal: 2,
      truncated: false,
    });
  });
  it("reads only the newest messages past the per-folder ceiling", async () => {
    const inbox = Array.from({ length: 5 }, (_, i) => ({
      header: `To: n${i}@piloto.test\r\n`,
      date: `2026-01-0${i + 1}`,
    }));
    const result = await scanAccount(session({ INBOX: inbox }), {
      ownDomains: new Set(["piloto.test"]),
      perFolderCap: 2,
      batchSize: 1,
    });
    expect([...result.addresses.keys()].sort()).toEqual(["n3@piloto.test", "n4@piloto.test"]);
    expect(result.truncated).toBe(true);
  });
  it("unfolds continued header lines", () => {
    expect(headerFields("To: a@x.test,\r\n b@x.test\r\nCc: c@x.test\r\n").get("to")).toEqual([
      " a@x.test, b@x.test",
    ]);
  });
});
