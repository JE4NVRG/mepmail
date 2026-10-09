import { describe, expect, it } from "vitest";
import {
  applicableItems,
  type DiscoveredAddress,
  defaultPlan,
  domainOf,
  groupByDomain,
  labelFor,
  localPartOf,
  mainMailboxForDomain,
  planSummary,
  providerPreset,
  recentlyUsed,
  type TeamMailbox,
} from "./mailbox-migration";

const now = new Date("2026-10-09T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const found = (
  address: string,
  messages: number,
  lastSeenAt: Date | null,
  inMepMail: DiscoveredAddress["inMepMail"] = null,
  mailboxId: string | null = null,
): DiscoveredAddress => ({
  address,
  domain: domainOf(address),
  localPart: localPartOf(address),
  messages,
  lastSeenAt,
  inMepMail,
  mailboxId,
});

const mailboxes: TeamMailbox[] = [
  { id: "mb-jean-url", address: "jean@urlpivot.app", label: "Jean", ownerUserId: "jean" },
  { id: "mb-sup-url", address: "suporte@urlpivot.app", label: "Suporte", ownerUserId: "luna" },
  { id: "mb-jean-je4", address: "jean@je4ndev.com", label: "Jean", ownerUserId: "jean" },
];

const discovered: DiscoveredAddress[] = [
  found("jean@urlpivot.app", 900, daysAgo(1), "mailbox", "mb-jean-url"),
  found("partners@urlpivot.app", 40, daysAgo(20)),
  found("social@urlpivot.app", 3, daysAgo(500)),
  found("support@urlpivot.app", 120, daysAgo(2)),
  found("jean@arremataradar.com", 15, daysAgo(60)),
  found("vendas@arremataradar.com", 2, daysAgo(400)),
  found("support@je4ndev.com", 30, daysAgo(5), "alias", "mb-jean-je4"),
];

describe("groupByDomain", () => {
  it("orders domains and addresses by traffic and keeps the newest date per domain", () => {
    const groups = groupByDomain(discovered);
    expect(groups.map((group) => group.domain)).toEqual([
      "urlpivot.app",
      "je4ndev.com",
      "arremataradar.com",
    ]);
    expect(groups[0]?.addresses.map((entry) => entry.localPart)).toEqual([
      "jean",
      "support",
      "partners",
      "social",
    ]);
    expect(groups[0]?.messages).toBe(1063);
    expect(groups[0]?.lastSeenAt).toEqual(daysAgo(1));
  });
});

describe("recentlyUsed", () => {
  it("counts the last twelve months, nothing older, never an unknown date", () => {
    expect(recentlyUsed(found("a@x.dev", 1, daysAgo(360)), now)).toBe(true);
    expect(recentlyUsed(found("a@x.dev", 1, daysAgo(370)), now)).toBe(false);
    expect(recentlyUsed(found("a@x.dev", 1, null), now)).toBe(false);
    expect(recentlyUsed(found("a@x.dev", 1, "2026-10-01T00:00:00Z" as unknown as Date), now)).toBe(
      true,
    );
  });
});

describe("mainMailboxForDomain", () => {
  it("prefers the current user's own mailbox on the domain", () => {
    expect(mainMailboxForDomain("urlpivot.app", mailboxes, "luna")?.id).toBe("mb-sup-url");
    expect(mainMailboxForDomain("urlpivot.app", mailboxes, "jean")?.id).toBe("mb-jean-url");
    expect(mainMailboxForDomain("urlpivot.app", mailboxes, "someone")?.id).toBe("mb-jean-url");
    expect(mainMailboxForDomain("arremataradar.com", mailboxes, "jean")).toBeNull();
  });
});

describe("defaultPlan", () => {
  it("leaves existing addresses alone, aliases where a mailbox exists, mailboxes elsewhere", () => {
    const plan = defaultPlan(discovered, mailboxes, "jean", now);
    const byAddress = Object.fromEntries(plan.items.map((item) => [item.address, item]));
    expect(byAddress["jean@urlpivot.app"]?.action).toBe("ignore");
    expect(byAddress["support@je4ndev.com"]?.action).toBe("ignore");
    expect(byAddress["partners@urlpivot.app"]).toEqual({
      address: "partners@urlpivot.app",
      action: "alias",
      mailboxId: "mb-jean-url",
      ownerUserId: "jean",
      label: "Partners",
    });
    expect(byAddress["jean@arremataradar.com"]?.action).toBe("mailbox");
    expect(byAddress["jean@arremataradar.com"]?.mailboxId).toBeNull();
    expect(plan.selected).toEqual([
      "partners@urlpivot.app",
      "support@urlpivot.app",
      "jean@arremataradar.com",
    ]);
  });
});

describe("labelFor", () => {
  it("capitalizes the words of a local part", () => {
    expect(labelFor("support")).toBe("Support");
    expect(labelFor("jean.silva")).toBe("Jean Silva");
    expect(labelFor("no-reply_bot")).toBe("No Reply Bot");
  });
});

describe("planSummary", () => {
  const context = {
    addresses: discovered,
    mailboxes,
    domains: [
      { id: "d1", name: "urlpivot.app" },
      { id: "d2", name: "je4ndev.com" },
    ],
    aliasCounts: { "mb-jean-url": 19 },
    seatsAvailable: 0,
  };

  it("previews outcomes per address and totals", () => {
    const { items } = defaultPlan(discovered, mailboxes, "jean", now);
    const selected = new Set([
      "partners@urlpivot.app",
      "support@urlpivot.app",
      "jean@arremataradar.com",
      "social@urlpivot.app",
    ]);
    const summary = planSummary(items, selected, context);
    const outcome = Object.fromEntries(summary.results.map((r) => [r.address, r.outcome]));
    expect(outcome["jean@urlpivot.app"]).toBe("exists");
    expect(outcome["support@je4ndev.com"]).toBe("exists");
    expect(outcome["vendas@arremataradar.com"]).toBe("ignored");
    // 19 aliases exist: the first planned alias fits, the second and third do not.
    expect(outcome["partners@urlpivot.app"]).toBe("ok");
    expect(outcome["social@urlpivot.app"]).toBe("over_alias_cap");
    expect(outcome["support@urlpivot.app"]).toBe("over_alias_cap");
    // arremataradar.com is not a MepMail domain yet.
    expect(outcome["jean@arremataradar.com"]).toBe("domain_missing");
    expect(summary).toMatchObject({ newMailboxes: 0, newAliases: 1, licensesNeeded: 0 });
  });

  it("charges missing license seats to the last planned mailboxes", () => {
    const items = [
      {
        address: "a@je4ndev.com",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "jean",
        label: "A",
      },
      {
        address: "b@je4ndev.com",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "jean",
        label: "B",
      },
      {
        address: "c@je4ndev.com",
        action: "alias" as const,
        mailboxId: "mb-jean-je4",
        ownerUserId: null,
        label: null,
      },
    ];
    const summary = planSummary(items, new Set(items.map((item) => item.address)), {
      ...context,
      addresses: [],
      aliasCounts: {},
      seatsAvailable: 1,
    });
    expect(summary.results.map((r) => r.outcome)).toEqual(["ok", "needs_license", "ok"]);
    expect(summary).toMatchObject({ newMailboxes: 2, newAliases: 1, licensesNeeded: 1 });
    expect(applicableItems(items, summary).map((item) => item.address)).toEqual([
      "a@je4ndev.com",
      "c@je4ndev.com",
    ]);
  });

  it("rejects an alias that points at a mailbox on another domain, a bad local part and a taken address", () => {
    const items = [
      {
        address: "x@je4ndev.com",
        action: "alias" as const,
        mailboxId: "mb-jean-url",
        ownerUserId: null,
        label: null,
      },
      {
        address: "bad..name@je4ndev.com",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "jean",
        label: "Bad",
      },
      {
        address: "jean@je4ndev.com",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "jean",
        label: "Jean",
      },
    ];
    const summary = planSummary(items, new Set(items.map((item) => item.address)), {
      ...context,
      addresses: [],
      seatsAvailable: null,
    });
    expect(summary.results.map((r) => r.outcome)).toEqual(["invalid", "invalid", "conflict"]);
  });
});

describe("providerPreset", () => {
  it("knows the hosts and which providers need an app password", () => {
    expect(providerPreset("purelymail")).toMatchObject({
      host: "imap.purelymail.com",
      port: 993,
      appPassword: false,
    });
    expect(providerPreset("gmail").appPassword).toBe(true);
    expect(providerPreset("imap").host).toBe("");
  });
});
