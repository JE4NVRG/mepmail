import { connect, type Socket } from "node:net";

/**
 * A minimal IMAP client for the tests: one command at a time, the whole response
 * (untagged lines and literals) up to its tagged completion, as text.
 */
export class TestImapClient {
  private buffer = "";
  private waiters: (() => void)[] = [];
  private tag = 0;
  readonly untagged: string[] = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /** `preamble` is written first (a PROXY header, as the host's nginx sends). */
  static async open(port: number, preamble?: string): Promise<TestImapClient> {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    if (preamble) socket.write(preamble);
    const client = new TestImapClient(socket);
    await client.until((text) => /^\* OK/m.test(text));
    client.buffer = "";
    return client;
  }

  private async until(done: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.buffer)) {
      if (Date.now() > deadline) throw new Error(`IMAP timeout; got:\n${this.buffer}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.buffer;
  }

  /** Sends `command` (with literals given as Buffers) and returns the full response. */
  async send(command: string, literal?: Buffer): Promise<{ status: string; text: string }> {
    const tag = `T${++this.tag}`;
    this.buffer = "";
    if (literal) {
      this.socket.write(`${tag} ${command} {${literal.length}}\r\n`);
      await this.until((text) => /^\+ /m.test(text));
      this.buffer = "";
      this.socket.write(Buffer.concat([literal, Buffer.from("\r\n")]));
    } else this.socket.write(`${tag} ${command}\r\n`);
    const done = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, "m");
    const text = await this.until((t) => done.test(t));
    const status = done.exec(text)![0].trim();
    this.buffer = "";
    return { status, text };
  }

  /** IDLE until `seen` matches what the server pushed, then DONE. */
  async idle(seen: RegExp, timeoutMs = 10_000): Promise<string> {
    const tag = `T${++this.tag}`;
    this.buffer = "";
    this.socket.write(`${tag} IDLE\r\n`);
    await this.until((text) => /^\+ /m.test(text));
    const text = await this.until((t) => seen.test(t), timeoutMs);
    this.socket.write("DONE\r\n");
    await this.until((t) => new RegExp(`^${tag} OK`, "m").test(t));
    this.buffer = "";
    return text;
  }

  close() {
    this.socket.destroy();
  }
}
