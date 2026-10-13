import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

vi.mock("@/server/trpc", () => ({
  createContext: async () => ({
    session: { user: { id: "user-1" } },
    teamId: "team-1",
    role: "owner",
    db: {},
  }),
}));
vi.mock("@/server/mailboxes", () => ({
  mailboxRegistryEnabled: () => true,
  mailboxActorAccessEnabled: async () => true,
}));

const {
  isPersonalMailDomain,
  normalizeLogoDomain,
  organizationalDomain,
  senderLogoFor,
  senderPictureUrl,
} = await import("../src/lib/mailbox-sender-logo");
const { readSenderPictureToken, senderPictureToken } = await import(
  "../src/server/mailbox-sender-picture"
);
const logo = await import("../src/server/mailbox-sender-logo");
const { clearSenderLogoCache, iconLinks, resolveSenderPicture, safeSvg, sniffImage } = logo;
type SenderLogoDeps = import("../src/server/mailbox-sender-logo").SenderLogoDeps;

const passed = (policy: string | null) => ({
  verdicts: { virus: "PASS", spam: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
  dmarcPolicy: policy,
});

describe("which sender gets a picture", () => {
  it("only mail that passed DMARC; BIMI only under an enforced policy", () => {
    expect(
      senderLogoFor({
        kind: "inbox",
        from: "Ship@Amazon.com.br",
        inboundAssessment: passed("reject"),
      }),
    ).toEqual({ address: "ship@amazon.com.br", domain: "amazon.com.br", bimi: true });
    expect(
      senderLogoFor({
        kind: "inbox",
        from: "news@shop.example",
        inboundAssessment: passed("none"),
      }),
    ).toEqual({ address: "news@shop.example", domain: "shop.example", bimi: false });
    // A forged From (DMARC failed) never borrows the brand's mark.
    expect(
      senderLogoFor({
        kind: "inbox",
        from: "security@amazon.com",
        inboundAssessment: { verdicts: { dmarc: "FAIL" }, dmarcPolicy: "reject" },
      }),
    ).toBeNull();
    expect(
      senderLogoFor({ kind: "inbox", from: "x@amazon.com", inboundAssessment: null }),
    ).toBeNull();
    expect(
      senderLogoFor({ kind: "sent", from: "me@amazon.com", inboundAssessment: passed("reject") }),
    ).toBeNull();
  });

  it("gives personal mail services no brand mark, only the person's Gravatar", () => {
    expect(
      senderLogoFor({ kind: "inbox", from: "ana@gmail.com", inboundAssessment: passed("none") }),
    ).toEqual({ address: "ana@gmail.com", domain: null, bimi: false });
    expect(isPersonalMailDomain("eu.outlook.com")).toBe(true);
    expect(isPersonalMailDomain("amazon.com")).toBe(false);
  });

  it("reads the organizational domain", () => {
    expect(organizationalDomain("marketplace.amazon.com.br")).toBe("amazon.com.br");
    expect(organizationalDomain("mail.github.com")).toBe("github.com");
    expect(normalizeLogoDomain(" Amazon.COM. ")).toBe("amazon.com");
    expect(normalizeLogoDomain("localhost")).toBeNull();
  });
});

describe("picture tokens (signed by the server while listing)", () => {
  it("carry the row's own verdicts; nothing for mail that did not pass DMARC", () => {
    const token = senderPictureToken({
      kind: "inbox",
      from: "news@shop.example",
      inboundAssessment: passed("none"),
    });
    expect(token).toBeTruthy();
    const grant = readSenderPictureToken(token as string);
    // p=none: the token never allows BIMI, whatever the page asks.
    expect(grant).toMatchObject({ domain: "shop.example", bimi: false });
    expect(grant?.gravatar).toMatch(/^[0-9a-f]{64}$/);
    expect(
      senderPictureToken({
        kind: "inbox",
        from: "news@shop.example",
        inboundAssessment: { verdicts: { dmarc: "FAIL" }, dmarcPolicy: "reject" },
      }),
    ).toBeNull();
    expect(senderPictureUrl("a.b")).toBe("/api/mailboxes/sender-logo?t=a.b");
  });

  it("refuse a forged, edited or expired token", () => {
    const token = senderPictureToken({
      kind: "inbox",
      from: "news@shop.example",
      inboundAssessment: passed("reject"),
    }) as string;
    const [payload, signature] = token.split(".") as [string, string];
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        d: "attacker.example",
      }),
    ).toString("base64url");
    expect(readSenderPictureToken(`${edited}.${signature}`)).toBeNull();
    expect(readSenderPictureToken(`${payload}.${signature.slice(0, -2)}xx`)).toBeNull();
    expect(readSenderPictureToken("not-a-token")).toBeNull();
    expect(readSenderPictureToken(token, Date.now() + 30 * 24 * 3_600_000)).toBeNull();
  });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f90"/></svg>',
);

describe("what the server accepts as a picture", () => {
  it("types bytes by their signature, not by the server's word", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(SVG)).toBe("image/svg+xml");
    expect(
      sniffImage(Buffer.from("<html><body>not an image at all, just a page</body></html>")),
    ).toBeNull();
  });

  it("refuses SVG with anything active in it", () => {
    expect(safeSvg(SVG)).toBe(true);
    for (const bad of [
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="alert(1)"><rect/></svg>',
      "<svg><foreignObject><div/></foreignObject></svg>",
      '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg><image href="https://tracker.example/p.png"/></svg>',
    ])
      expect(safeSvg(Buffer.from(bad))).toBe(false);
  });

  it("orders a page's icon links, apple-touch-icon first, https only", () => {
    const links = iconLinks(
      `<link rel="icon" href="/favicon-16.png" sizes="16x16">
       <link rel="icon" href="/favicon-96.png" sizes="96x96">
       <link rel="apple-touch-icon" href="https://cdn.shop.example/touch.png">
       <link rel="icon" href="http://shop.example/insecure.png">`,
      new URL("https://shop.example/"),
    ).map((url) => url.href);
    expect(links).toEqual([
      "https://cdn.shop.example/touch.png",
      "https://shop.example/favicon-96.png",
      "https://shop.example/favicon-16.png",
    ]);
  });
});

function fakeDeps(
  txt: Record<string, string[][]>,
  pages: Record<string, { status?: number; body?: Buffer; location?: string; type?: string }>,
) {
  const asked: string[] = [];
  const txtAsked: string[] = [];
  const deps: SenderLogoDeps = {
    resolveTxt: async (name) => {
      txtAsked.push(name);
      const found = txt[name];
      if (!found) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return found;
    },
    get: async (url) => {
      asked.push(url.href);
      const page = pages[url.href];
      if (!page) return { status: 404, body: Buffer.alloc(0), location: null, contentType: "" };
      return {
        status: page.status ?? 200,
        body: page.body ?? Buffer.alloc(0),
        location: page.location ?? null,
        contentType: page.type ?? "",
      };
    },
  };
  return { deps, asked, txtAsked };
}

describe("resolving a sender's picture", () => {
  beforeEach(() => clearSenderLogoCache());

  it("uses the brand's BIMI logo when the token allows it", async () => {
    const { deps } = fakeDeps(
      { "default._bimi.amazon.com": [["v=BIMI1; l=https://bimi.example/amazon.svg; a="]] },
      { "https://bimi.example/amazon.svg": { body: SVG } },
    );
    const { logo } = await resolveSenderPicture(
      { domain: "amazon.com", bimi: true, gravatar: null },
      {},
      deps,
    );
    expect(logo?.contentType).toBe("image/svg+xml");
  });

  it("never looks BIMI up when the message's policy was not enforced", async () => {
    const { deps, txtAsked } = fakeDeps(
      { "default._bimi.shop.example": [["v=BIMI1; l=https://bimi.example/shop.svg"]] },
      {
        "https://shop.example/favicon.ico": {
          body: Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(60, 2)]),
        },
      },
    );
    const { logo } = await resolveSenderPicture(
      { domain: "shop.example", bimi: false, gravatar: null },
      {},
      deps,
    );
    expect(txtAsked).toEqual([]);
    expect(logo?.contentType).toBe("image/x-icon");
  });

  it("prefers the person's Gravatar over a website icon", async () => {
    const hash = "a".repeat(64);
    const { deps, asked } = fakeDeps(
      {},
      { [`https://gravatar.com/avatar/${hash}?d=404&s=96`]: { body: PNG } },
    );
    const { logo } = await resolveSenderPicture(
      { domain: null, bimi: false, gravatar: hash },
      {},
      deps,
    );
    expect(logo?.contentType).toBe("image/png");
    expect(asked).toEqual([`https://gravatar.com/avatar/${hash}?d=404&s=96`]);
  });

  it("never follows a redirect off https", async () => {
    const { deps } = fakeDeps(
      {},
      {
        "https://shop.example/": { status: 301, location: "http://shop.example/" },
        "https://shop.example/apple-touch-icon.png": {
          status: 302,
          location: "http://169.254.169.254/latest/meta-data",
        },
      },
    );
    const { logo } = await resolveSenderPicture(
      { domain: "shop.example", bimi: false, gravatar: null },
      {},
      deps,
    );
    expect(logo).toBeNull();
  });

  it("stops at the budget without fetching, and a cache hit costs nothing", async () => {
    const { deps, asked } = fakeDeps({}, { "https://shop.example/favicon.ico": { body: PNG } });
    const denied = await resolveSenderPicture(
      { domain: "shop.example", bimi: false, gravatar: null },
      { budget: () => false },
      deps,
    );
    expect(denied).toEqual({ logo: null, limited: true });
    expect(asked).toEqual([]);
    const found = await resolveSenderPicture(
      { domain: "shop.example", bimi: false, gravatar: null },
      {},
      deps,
    );
    expect(found.logo?.contentType).toBe("image/png");
    const before = asked.length;
    const again = await resolveSenderPicture(
      { domain: "shop.example", bimi: false, gravatar: null },
      { budget: () => false },
      deps,
    );
    expect(again.logo?.contentType).toBe("image/png");
    expect(asked.length).toBe(before);
  });
});

describe("the logo route", () => {
  it("looks nothing up for a forged or missing token, and takes BIMI only from the token", async () => {
    const resolve = vi.fn(async (_grant: unknown) => ({ logo: null, limited: false }));
    vi.resetModules();
    vi.doMock("@/server/mailbox-sender-logo", () => ({ resolveSenderPicture: resolve }));
    const { GET } = await import("../src/app/api/mailboxes/sender-logo/route");
    for (const url of [
      "https://mepmail.dev/api/mailboxes/sender-logo",
      "https://mepmail.dev/api/mailboxes/sender-logo?t=forged.token",
      "https://mepmail.dev/api/mailboxes/sender-logo?domain=attacker.example&bimi=1",
    ]) {
      const response = await GET(new Request(url));
      expect(response.status).toBe(404);
    }
    expect(resolve).not.toHaveBeenCalled();
    // A real token for p=none mail: ?bimi=1 on the URL changes nothing.
    const { senderPictureToken: sign } = await import("../src/server/mailbox-sender-picture");
    const token = sign({
      kind: "inbox",
      from: "news@shop.example",
      inboundAssessment: passed("none"),
    }) as string;
    const response = await GET(
      new Request(
        `https://mepmail.dev/api/mailboxes/sender-logo?t=${encodeURIComponent(token)}&bimi=1`,
      ),
    );
    expect(response.status).toBe(404);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ domain: "shop.example", bimi: false });
    vi.doUnmock("@/server/mailbox-sender-logo");
  });
});
