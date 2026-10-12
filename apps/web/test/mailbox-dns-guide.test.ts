import { describe, expect, it } from "vitest";
import { dnsProviderFor, mailboxDnsGuide, mailHostProvider } from "@/server/mailbox-dns-guide";

const MX = "inbound-smtp.us-east-1.amazonaws.com";

const zones: Record<string, string[]> = {
  "acme.com.br": ["a.sec.dns.br", "b.sec.dns.br"],
  "acme.dev": ["NIA.NS.CLOUDFLARE.COM.", "west.ns.cloudflare.com"],
};
const resolveNs = async (name: string) => {
  const ns = zones[name];
  if (!ns) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
  return ns;
};

describe("mailboxDnsGuide", () => {
  it("finds the zone above a subdomain and names the record relative to it", async () => {
    const guide = await mailboxDnsGuide("Mail.Acme.dev", MX, {
      resolveNs,
      resolveMx: async () => [],
    });
    expect(guide).toMatchObject({
      domain: "mail.acme.dev",
      zone: "acme.dev",
      recordName: "mail",
      provider: "cloudflare",
      nameservers: ["nia.ns.cloudflare.com", "west.ns.cloudflare.com"],
      mx: { exchange: MX, priority: 10 },
      current: [],
      otherProvider: null,
    });
  });

  it("names the primary by MX preference: a legacy provider at a higher one is a backup", async () => {
    // agenciamep.com on 2026-10-12: Correio at 10, Titan left at 50 and 60.
    const migrated = await mailboxDnsGuide("acme.com.br", MX, {
      resolveNs,
      resolveMx: async () => [
        { exchange: "mx1.titan.email", priority: 50 },
        { exchange: `${MX}.`, priority: 10 },
        { exchange: "mx2.titan.email", priority: 60 },
      ],
    });
    expect(migrated).toMatchObject({
      primary: "correio",
      otherProvider: null,
      backups: [
        { exchange: "mx1.titan.email", priority: 50, provider: "Titan" },
        { exchange: "mx2.titan.email", priority: 60, provider: "Titan" },
      ],
    });
    // Titan still first: it is the provider receiving today.
    const before = await mailboxDnsGuide("acme.com.br", MX, {
      resolveNs,
      resolveMx: async () => [
        { exchange: "mx1.titan.email", priority: 10 },
        { exchange: MX, priority: 20 },
      ],
    });
    expect(before).toMatchObject({ primary: "other", otherProvider: "Titan", backups: [] });
    const tie = await mailboxDnsGuide("acme.com.br", MX, {
      resolveNs,
      resolveMx: async () => [
        { exchange: "mx1.titan.email", priority: 10 },
        { exchange: MX, priority: 10 },
      ],
    });
    expect(tie).toMatchObject({ primary: "mixed", otherProvider: "Titan" });
  });

  it("says where mail goes today when the apex already has another provider", async () => {
    const guide = await mailboxDnsGuide("acme.com.br", MX, {
      resolveNs,
      resolveMx: async () => [
        { exchange: "mx2.titan.email", priority: 20 },
        { exchange: "mx1.titan.email.", priority: 10 },
      ],
    });
    expect(guide.recordName).toBe("@");
    expect(guide.provider).toBe("registrobr");
    expect(guide.otherProvider).toBe("Titan");
    expect(guide.current.map((r) => [r.exchange, r.priority, r.ours])).toEqual([
      ["mx1.titan.email", 10, false],
      ["mx2.titan.email", 20, false],
    ]);
  });

  it("marks our own record and survives DNS failures", async () => {
    const ready = await mailboxDnsGuide("acme.dev", MX, {
      resolveNs,
      resolveMx: async () => [{ exchange: `${MX}.`, priority: 10 }],
    });
    expect(ready.current).toEqual([{ exchange: MX, priority: 10, ours: true, provider: null }]);
    expect(ready.otherProvider).toBeNull();
    const offline = await mailboxDnsGuide("nowhere.invalid", MX, {
      resolveNs,
      resolveMx: async () => {
        throw new Error("ESERVFAIL");
      },
    });
    expect(offline).toMatchObject({ zone: "nowhere.invalid", provider: "other", current: [] });
  });

  it("recognises the common DNS hosts and mailbox providers", () => {
    expect(dnsProviderFor(["ns-123.awsdns-45.org"])).toBe("route53");
    expect(dnsProviderFor(["ns07.domaincontrol.com"])).toBe("godaddy");
    expect(dnsProviderFor(["ns1.dns-parking.com"])).toBe("hostinger");
    expect(dnsProviderFor(["ns1.example.net"])).toBe("other");
    expect(mailHostProvider("aspmx.l.google.com")).toBe("Google Workspace");
    expect(mailHostProvider("acme-com.mail.protection.outlook.com")).toBe("Microsoft 365");
    expect(mailHostProvider("mailserver.purelymail.com")).toBe("Purelymail");
    expect(mailHostProvider("mx.example.net")).toBeNull();
  });
});
