import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainFirst } from "@/app/onboarding/domain-first";
import {
  currentStep,
  type DomainRow,
  domainFromInput,
  flowDomain,
  initialRegistrar,
  providerSlug,
  suggestedLocalPart,
} from "@/app/onboarding/domain-first-model";
import domainsEn from "../messages/en/domains.json";
import en from "../messages/en/onboarding.json";
import domainsPt from "../messages/pt-BR/domains.json";
import pt from "../messages/pt-BR/onboarding.json";

type Fixture = {
  domains: DomainRow[];
  provider: { name: string; url?: string } | null;
  mailboxEnabled: boolean;
  mailboxes: number;
};
const hooks = vi.hoisted(() => ({
  fixture: {} as Fixture,
  track: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/trpc", () => {
  const endpoint = (path: string) => ({
    queryOptions: (input?: unknown, options?: Record<string, unknown>) => ({
      ...options,
      queryKey: [path, input],
    }),
    queryKey: () => [path],
    mutationOptions: (options: Record<string, unknown>) => ({ ...options, mutationPath: path }),
  });
  return {
    useTRPC: () => ({
      system: { features: endpoint("features") },
      domains: {
        list: endpoint("domains"),
        records: endpoint("records"),
        create: endpoint("create"),
        verify: endpoint("verify"),
      },
      mailboxes: { capabilities: endpoint("capabilities"), list: endpoint("mailboxes") },
    }),
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: [string, unknown?]; enabled?: boolean }) => {
    const [path] = options.queryKey;
    const f = hooks.fixture;
    let data: unknown;
    if (path === "domains") data = f.domains;
    if (path === "features") data = { regions: [{ code: "us-east-1", production: true }] };
    if (path === "records")
      data = {
        provider: f.provider,
        records: [{ group: "verification", type: "TXT", name: "x", value: "y", status: "pending" }],
      };
    if (path === "capabilities") data = { enabled: f.mailboxEnabled };
    if (path === "mailboxes")
      data =
        options.enabled === false
          ? undefined
          : { mailboxes: Array.from({ length: f.mailboxes }, (_, i) => ({ id: `m${i}` })) };
    return {
      data,
      isPending: data === undefined && options.enabled !== false,
      isSuccess: data !== undefined,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useMutation: () => ({ mutate: hooks.mutate, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/app/onboarding/onboarding-track", () => ({ useOnboardingTrack: () => hooks.track }));
vi.mock("@/app/(dashboard)/domains/cloudflare-setup", () => ({
  CloudflareSetup: ({ domainName }: { domainName: string }) =>
    createElement("div", { "data-testid": "cloudflare-setup" }, domainName),
}));
vi.mock("@/app/(dashboard)/domains/domain-status", () => ({
  DomainStatusBadge: ({ status }: { status: string }) =>
    createElement("span", { "data-status": status }, status),
}));
vi.mock("@/components/dns-records-table", () => ({
  DnsRecordsTable: ({ records }: { records: unknown[] }) =>
    createElement("table", { "data-records": records.length }),
  DnsRecordsTableSkeleton: () => null,
}));

const pending: DomainRow = { id: "d1", name: "loja.com.br", status: "pending" };
const verified: DomainRow = { id: "d1", name: "loja.com.br", status: "verified" };

function render(locale: "en" | "pt-BR" = "en") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: {
        onboarding: locale === "en" ? en : pt,
        domains: locale === "en" ? domainsEn : domainsPt,
      },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(DomainFirst, { userEmail: "Member+news@example.com" }),
    }),
  );
}

/** Text as React renders it into HTML (escaped quotes and apostrophes). */
function html(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
}

/** The registrar radio rendered as checked. */
function checkedRegistrar(out: string) {
  const input = out.match(/<input[^>]*type="radio"[^>]*checked=""[^>]*>/)?.[0] ?? "";
  return input.match(/value="([a-z]+)"/)?.[1] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.fixture = { domains: [], provider: null, mailboxEnabled: true, mailboxes: 0 };
});

describe("domain-first model", () => {
  it("finds the domain in whatever was typed", () => {
    expect(domainFromInput("https://www.Loja.com.br/contato")).toBe("loja.com.br");
    expect(domainFromInput("jean@loja.com.br")).toBe("loja.com.br");
    expect(domainFromInput(" loja.com.br. ")).toBe("loja.com.br");
    expect(domainFromInput("http://mail.loja.com.br:8080?x=1")).toBe("mail.loja.com.br");
    expect(domainFromInput("loja")).toBeNull();
    expect(domainFromInput("")).toBeNull();
    expect(domainFromInput("loja .com")).toBeNull();
  });

  it("maps the detected DNS host to a guide", () => {
    expect(providerSlug(null)).toBe("unknown");
    expect(providerSlug({ name: "Cloudflare", url: "https://dash.cloudflare.com" })).toBe(
      "cloudflare",
    );
    expect(providerSlug({ name: "Registro.br" })).toBe("registrobr");
    expect(providerSlug({ name: "Hostinger" })).toBe("hostinger");
    expect(providerSlug({ name: "GoDaddy" })).toBe("godaddy");
    expect(providerSlug({ name: "Namecheap" })).toBe("namecheap");
    expect(providerSlug({ name: "Vercel" })).toBe("other");
    expect(initialRegistrar({ name: "GoDaddy" })).toBe("godaddy");
    expect(initialRegistrar({ name: "Cloudflare" })).toBe("other");
    expect(initialRegistrar(null)).toBe("other");
  });

  it("follows a verified domain first, then one waiting for DNS", () => {
    const failed = { id: "f", name: "a.com", status: "failed" };
    const waiting = { id: "w", name: "b.com", status: "temporary_failure" };
    const ok = { id: "v", name: "c.com", status: "verified" };
    expect(flowDomain([failed, waiting, ok])?.id).toBe("v");
    expect(flowDomain([failed, waiting])?.id).toBe("w");
    expect(flowDomain([failed])?.id).toBe("f");
    expect(flowDomain([])).toBeNull();
  });

  it("moves through the steps, and a skip puts a step off without marking it done", () => {
    const none = new Set<"domain" | "dns" | "mailbox">();
    expect(currentStep({ domain: null, hasMailbox: false, skipped: none })).toBe("domain");
    expect(currentStep({ domain: null, hasMailbox: false, skipped: new Set(["domain"]) })).toBe(
      "done",
    );
    expect(currentStep({ domain: pending, hasMailbox: false, skipped: none })).toBe("dns");
    expect(currentStep({ domain: pending, hasMailbox: false, skipped: new Set(["dns"]) })).toBe(
      "mailbox",
    );
    expect(currentStep({ domain: verified, hasMailbox: false, skipped: none })).toBe("mailbox");
    expect(
      currentStep({ domain: verified, hasMailbox: false, skipped: new Set(["mailbox"]) }),
    ).toBe("agent");
    expect(currentStep({ domain: verified, hasMailbox: true, skipped: none })).toBe("agent");
  });

  it("suggests the person's own local part for the first mailbox", () => {
    expect(suggestedLocalPart("Jean.Vargas+news@example.com")).toBe("jean.vargas");
    expect(suggestedLocalPart("@example.com")).toBe("voce");
    expect(suggestedLocalPart("--@example.com")).toBe("voce");
  });
});

for (const [locale, copy] of [
  ["en", en],
  ["pt-BR", pt],
] as const) {
  const f = copy.domainFirst;
  describe(`DomainFirst (${locale})`, () => {
    it("asks for the domain first, says no hosting is needed, and can be skipped", () => {
      const out = render(locale);
      expect(out).toContain(html(f.title));
      expect(out).toContain(html(f.domain.title));
      expect(out).toContain(html(f.domain.body));
      expect(out).toContain(`placeholder="${f.domain.placeholder}"`);
      expect(out).toContain(html(f.skip));
      // Later steps wait for the domain.
      expect(out).toContain(html(f.dns.locked));
      expect(out).toContain(html(f.mailbox.locked));
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("offers the one-click Cloudflare setup when the domain's DNS is there", () => {
      hooks.fixture.domains = [pending];
      hooks.fixture.provider = { name: "Cloudflare", url: "https://dash.cloudflare.com" };
      const out = render(locale);
      expect(out).toContain('data-testid="cloudflare-setup"');
      expect(out).toContain(html(f.dns.manual));
      expect(out).toContain(
        html(f.dns.detected.replace("{domain}", "loja.com.br").replace("{provider}", "Cloudflare")),
      );
      expect(out).toContain(html(f.dns.verify));
    });

    it("opens the guide of the detected registrar, with its panel link and the records", () => {
      hooks.fixture.domains = [pending];
      hooks.fixture.provider = { name: "Registro.br", url: "https://registro.br/painel/" };
      const out = render(locale);
      expect(out).not.toContain('data-testid="cloudflare-setup"');
      expect(checkedRegistrar(out)).toBe("registrobr");
      for (const line of f.guides.registrobr.steps) expect(out).toContain(html(line));
      expect(out).toContain('href="https://registro.br/painel/"');
      expect(out).toContain('data-records="1"');
      for (const key of ["registrobr", "hostinger", "godaddy", "namecheap", "other"] as const)
        expect(out).toContain(html(f.guides[key].name));
    });

    it("falls back to the general guide when the DNS host is unknown", () => {
      hooks.fixture.domains = [pending];
      const out = render(locale);
      expect(out).toContain(html(f.dns.unknown.replace("{domain}", "loja.com.br")));
      expect(checkedRegistrar(out)).toBe("other");
      for (const line of f.guides.other.steps) expect(out).toContain(html(line));
    });

    it("once verified, suggests the first mailbox on the domain with the person's name", () => {
      hooks.fixture.domains = [verified];
      const out = render(locale);
      expect(out).toContain(html(f.dns.verified.replace("{domain}", "loja.com.br")));
      expect(out).toContain(html(f.mailbox.cta.replace("{address}", "member@loja.com.br")));
      expect(out).toContain('href="/mail?new=1&amp;domain=d1&amp;local=member"');
      expect(out).toContain(html(f.agent.locked));
    });

    it("with a mailbox in place, leads to the optional agent", () => {
      hooks.fixture.domains = [verified];
      hooks.fixture.mailboxes = 1;
      const out = render(locale);
      expect(out).toContain(html(f.mailbox.done));
      expect(out).toContain('href="/mail"');
      expect(out).toContain(html(f.agent.title));
      expect(out).toContain('href="/mail/settings?tab=agents"');
    });
  });
}
