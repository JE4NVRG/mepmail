import type { Db } from "@millionsend/db";
import { foldText, holdTeamForReview, senderName } from "./send-review.js";
import { parseMailbox } from "./sender-address.js";

export interface PreSendContentInput {
  from: string;
  subject: string;
  html?: string | null;
  text?: string | null;
}

/** No URLs, tokens, body excerpts or recipients may enter an alert. */
export type PreSendContentVerdict =
  | { action: "allow" }
  | { action: "hold"; code: "brand_account_link_mismatch"; brand: string };

const BRANDS: readonly { name: string; terms: readonly string[]; domains: readonly string[] }[] = [
  { name: "Apple", terms: ["apple", "icloud"], domains: ["apple.com", "icloud.com"] },
  { name: "Spotify", terms: ["spotify"], domains: ["spotify.com"] },
  { name: "PayPal", terms: ["paypal"], domains: ["paypal.com", "paypalobjects.com"] },
  {
    name: "Microsoft",
    terms: ["microsoft", "outlook", "office 365"],
    domains: ["microsoft.com", "live.com", "outlook.com", "office.com", "microsoftonline.com"],
  },
  {
    name: "Google",
    terms: ["google", "gmail"],
    domains: ["google.com", "gmail.com", "accounts.google.com"],
  },
  { name: "Netflix", terms: ["netflix"], domains: ["netflix.com"] },
  { name: "Itau", terms: ["itau"], domains: ["itau.com.br"] },
  { name: "Bradesco", terms: ["bradesco"], domains: ["bradesco.com.br", "banco.bradesco"] },
  {
    name: "Santander",
    terms: ["santander"],
    domains: ["santander.com", "santander.com.br", "santander.pt"],
  },
  { name: "Nubank", terms: ["nubank"], domains: ["nubank.com.br"] },
  { name: "Caixa", terms: ["caixa economica", "caixa"], domains: ["caixa.gov.br"] },
  { name: "Banco do Brasil", terms: ["banco do brasil"], domains: ["bb.com.br"] },
  { name: "Banco CTT", terms: ["banco ctt"], domains: ["bancoctt.pt"] },
  { name: "Revolut", terms: ["revolut"], domains: ["revolut.com"] },
  { name: "Bank of America", terms: ["bank of america"], domains: ["bankofamerica.com"] },
  { name: "Chase", terms: ["chase bank", "chase"], domains: ["chase.com"] },
];

function decode(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, n: string) => {
      const point = n[0]?.toLowerCase() === "x" ? Number.parseInt(n.slice(1), 16) : Number(n);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp|colon|sol|tab|newline);/gi,
      (_, n: string) =>
        ({
          amp: "&",
          quot: '"',
          apos: "'",
          lt: "<",
          gt: ">",
          nbsp: " ",
          colon: ":",
          sol: "/",
          tab: "\t",
          newline: "\n",
        })[n.toLowerCase()] ?? " ",
    );
}

const aligned = (host: string, domains: readonly string[]): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** Bounded deterministic preflight; never fetches a link or calls a remote classifier.
 * A mention alone is NOT phishing. All four signals must agree: brand, account/
 * payment action, off-brand destination, and non-aligned authenticated From.
 * Throwing is intentional: callers must preserve the payload and fail closed.
 */
export function evaluatePreSendContent(input: PreSendContentInput): PreSendContentVerdict {
  if (
    [input.from, input.subject, input.html ?? "", input.text ?? ""].some(
      (s) => typeof s !== "string",
    ) ||
    (input.html?.length ?? 0) + (input.text?.length ?? 0) > 2_000_000
  ) {
    throw new Error("pre_send_content_unavailable");
  }
  const html = input.html ?? "";
  const visible = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?(?:p|div|br|table|tr|td|li|h[1-6])\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  );
  const words = foldText(
    `${senderName(input.from)} ${input.subject} ${visible} ${input.text ?? ""}`,
  );
  const action =
    /\b(account|conta|cuenta|compte|password|senha|login|sign in|payment|pagamento|pagamento|billing|fatura|cartao|card|subscription|assinatura|apple id)\b/.test(
      words,
    ) &&
    /\b(verify|verifique|verificar|confirm|confirme|confirmar|update|atualize|atualizar|reset|redefin|recover|recuper|suspend|suspens|suspended|suspensa|bloquead|locked|failed|falhou|declined|recusad|expir|renew|renov|pagar|pay|regulariz|validate|validar|reativ|reactivat)\w*/.test(
      words,
    );
  if (!action) return { action: "allow" };
  const links = [...html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) =>
    decode(m[1] ?? m[2] ?? m[3] ?? ""),
  );
  // Visible HTML text is a destination signal too, even without an href.
  links.push(...(`${visible} ${input.text ?? ""}`.match(/https?:\/\/[^\s<>"']+/gi) ?? []));
  const destinations = links.flatMap((link) => {
    try {
      const url = new URL(link.startsWith("//") ? `https:${link}` : link);
      return ["https:", "http:"].includes(url.protocol) ? [url.hostname.toLowerCase()] : [];
    } catch {
      return [];
    }
  });
  const address = parseMailbox(input.from)?.address ?? "";
  const senderDomain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  for (const brand of BRANDS) {
    if (
      brand.terms.some((term) => ` ${words} `.includes(` ${term} `)) &&
      !aligned(senderDomain, brand.domains) &&
      destinations.some((host) => !aligned(host, brand.domains))
    ) {
      return { action: "hold", code: "brand_account_link_mismatch", brand: brand.name };
    }
  }
  return { action: "allow" };
}

/** A system tag, a past review, age and marketing=false are not exemptions.
 * A held verdict blocks THIS payload even if a concurrent release wins the CAS.
 */
export async function screenPreSendContent(
  db: Db,
  input: PreSendContentInput & { teamId: string; now?: Date },
): Promise<PreSendContentVerdict> {
  const now = input.now ?? new Date();
  const verdict = evaluatePreSendContent(input);
  if (verdict.action === "hold") {
    await holdTeamForReview(db, {
      teamId: input.teamId,
      reason: "content",
      now,
      note: `Pre-send policy: ${verdict.code} (${verdict.brand})`,
    });
  }
  return verdict;
}
