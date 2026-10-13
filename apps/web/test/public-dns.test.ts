import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  servers: [] as string[],
  publicAnswer: (): Promise<{ exchange: string; priority: number }[]> => Promise.resolve([]),
  serverAnswer: vi.fn(async () => [{ exchange: "mx.cached-old.example", priority: 10 }]),
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers(servers: string[]) {
      h.servers = servers;
    }
    resolveMx() {
      return h.publicAnswer();
    }
  },
  resolveMx: h.serverAnswer,
}));

const { PUBLIC_DNS_SOURCE, SERVER_DNS_SOURCE, resolveMxPublic } = await import(
  "../src/server/public-dns"
);

const fail = (code: string) => Object.assign(new Error(code), { code });

describe("MX from public DNS, with its source", () => {
  beforeEach(() => {
    h.serverAnswer.mockClear();
  });
  it("asks the public resolvers directly, not the server's cache", async () => {
    h.publicAnswer = async () => [
      { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
    ];
    expect(await resolveMxPublic("example.com")).toEqual({
      records: [{ exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 }],
      source: PUBLIC_DNS_SOURCE,
    });
    expect(h.servers).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(h.serverAnswer).not.toHaveBeenCalled();
  });
  it("reads no MX as an answer from public DNS", async () => {
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      h.publicAnswer = () => Promise.reject(fail(code));
      expect(await resolveMxPublic("example.com")).toEqual({
        records: [],
        source: PUBLIC_DNS_SOURCE,
      });
    }
    expect(h.serverAnswer).not.toHaveBeenCalled();
  });
  it("says so when it falls back to the server's resolver", async () => {
    h.publicAnswer = () => Promise.reject(fail("ECONNREFUSED"));
    expect(await resolveMxPublic("example.com")).toEqual({
      records: [{ exchange: "mx.cached-old.example", priority: 10 }],
      source: SERVER_DNS_SOURCE,
    });
  });
});
