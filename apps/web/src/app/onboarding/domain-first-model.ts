// Pure pieces of the domain-first onboarding: what the person typed as a
// domain, which registrar guide to show, which step comes next, and the
// "skip for now" choices kept on this device.

/** Mirrors the domains router's hostname check (lowercase labels, a 2–63 letter TLD). */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The domain inside whatever was typed: "https://www.Loja.com.br/contato",
 * "jean@loja.com.br" and "loja.com.br." all become "loja.com.br". Returns null
 * when what is left is not a hostname.
 */
export function domainFromInput(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "").replace(/\.$/, "");
  if (value.startsWith("www.")) value = value.slice(4);
  return HOSTNAME_RE.test(value) ? value : null;
}

/** The registrar guides, in the order the picker shows them. */
export const REGISTRARS = ["registrobr", "hostinger", "godaddy", "namecheap", "other"] as const;
export type Registrar = (typeof REGISTRARS)[number];

/** Where each registrar's DNS editor starts (the "other" guide has none). */
export const REGISTRAR_URLS: Record<Exclude<Registrar, "other">, string> = {
  registrobr: "https://registro.br/painel/",
  hostinger: "https://hpanel.hostinger.com/domains",
  godaddy: "https://dcc.godaddy.com/control/portfolio",
  namecheap: "https://ap.www.namecheap.com/domains/list/",
};

/** The DNS host the server detected from the domain's NS records (domains.records). */
export type DnsProvider = { name: string; url?: string } | null;

/** "cloudflare", a registrar guide, or "unknown" when the NS answer named nothing we know. */
export function providerSlug(provider: DnsProvider): Registrar | "cloudflare" | "unknown" {
  switch (provider?.name) {
    case undefined:
      return "unknown";
    case "Cloudflare":
      return "cloudflare";
    case "Registro.br":
      return "registrobr";
    case "Hostinger":
      return "hostinger";
    case "GoDaddy":
      return "godaddy";
    case "Namecheap":
      return "namecheap";
    default:
      return "other";
  }
}

/** The guide to open first: the detected registrar, else the general one. */
export function initialRegistrar(provider: DnsProvider): Registrar {
  const slug = providerSlug(provider);
  return slug === "cloudflare" || slug === "unknown" ? "other" : slug;
}

export type DomainRow = { id: string; name: string; status: string; createdAt?: Date | string };

/**
 * The domain the flow follows: a verified one first, then one still waiting
 * for DNS, then the newest of the rest (a failed verification can be retried).
 */
export function flowDomain(domains: readonly DomainRow[]): DomainRow | null {
  return (
    domains.find((domain) => domain.status === "verified") ??
    domains.find(
      (domain) => domain.status === "pending" || domain.status === "temporary_failure",
    ) ??
    domains[0] ??
    null
  );
}

export type FlowStep = "domain" | "dns" | "mailbox" | "agent" | "done";
export type SkippableStep = "domain" | "dns" | "mailbox";

/**
 * The step to work on now. A skip moves past its step without pretending it
 * is done: the domain skip leaves nothing to do here (every later step needs
 * a domain), so the page leads with the API path instead.
 */
export function currentStep({
  domain,
  hasMailbox,
  skipped,
}: {
  domain: DomainRow | null;
  hasMailbox: boolean;
  skipped: ReadonlySet<SkippableStep>;
}): FlowStep {
  if (!domain) return skipped.has("domain") ? "done" : "domain";
  if (domain.status !== "verified" && !skipped.has("dns")) return "dns";
  if (!hasMailbox && !skipped.has("mailbox")) return "mailbox";
  return "agent";
}

/** A local part to suggest for the first mailbox: the person's own, kept to safe characters. */
export function suggestedLocalPart(userEmail: string): string {
  const local = (userEmail.split("@")[0] ?? "")
    .toLowerCase()
    .split("+")[0]
    ?.replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "");
  return local && local.length <= 64 ? local : "voce";
}

const SKIP_KEY = "mepmail.onboarding.skipped";

/** The steps skipped on this device. Storage can be missing or blocked: then nothing was skipped. */
export function readSkipped(): Set<SkippableStep> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SKIP_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((step): step is SkippableStep =>
            ["domain", "dns", "mailbox"].includes(step as string),
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeSkipped(skipped: ReadonlySet<SkippableStep>): void {
  try {
    window.localStorage.setItem(SKIP_KEY, JSON.stringify([...skipped]));
  } catch {
    // A private window or blocked storage: the skip lasts until the page reloads.
  }
}
