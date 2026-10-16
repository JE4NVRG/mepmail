import { decodeEntities } from "./abuse-judge/block.js";
import type { RevealSpan } from "./content-reveal.js";
import { redactRevealedText, renderRevealedBody } from "./content-reveal-render.js";
import { isIpLiteral } from "./email-insights.js";
import { registrableDomain } from "./org-domain.js";

const MASK = "[redigido]";
const URLS = /(?:(?:https?:)?\/\/|\bwww\.)[^\s<>"'`)]+/gi;
const EMAILS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PREFIXED_KEYS = /(?:[spr]k_(?:live|test)_|whsec_|gh[pousr]_|ms_)[A-Za-z0-9_-]+/g;
const LABELLED_SECRET =
  /\b(?:password|senha|token|otp|pin|api[_ -]?key|chave[_ -]?api)\s*[:=]\s*["']?[^\s<>"']+/gi;
const LONG_NUMBER = /(?<!\w)\+?\d[\d ()./-]{6,}\d(?!\w)/g;

/** Never transport URL credentials, paths, queries or fragments to staging. */
function reducedUrl(raw: string): string {
  try {
    const parsed = new URL(
      raw.startsWith("//") ? `https:${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
    const host = isIpLiteral(parsed.hostname)
      ? parsed.hostname
      : registrableDomain(parsed.hostname);
    return `${parsed.protocol}//${host}/…`;
  } catch {
    return MASK;
  }
}

function transportSpans(spans: RevealSpan[]): { spans: RevealSpan[]; redactions: number } {
  let redactions = 0;
  const result = spans.map((span): RevealSpan => {
    let text = span.text;
    for (const [pattern, replacement] of [
      [URLS, reducedUrl],
      [EMAILS, () => MASK],
      [PREFIXED_KEYS, () => MASK],
      [LABELLED_SECRET, () => MASK],
      [LONG_NUMBER, () => MASK],
    ] as const) {
      text = text.replace(pattern, (raw) => {
        redactions += 1;
        return replacement(raw);
      });
    }
    return span.redacted || text !== span.text ? { text, redacted: true } : { text };
  });
  return { spans: result, redactions };
}

function boundedSpans(spans: RevealSpan[], budget: number): RevealSpan[] {
  const result: RevealSpan[] = [];
  let remaining = budget;
  for (const span of spans) {
    if (remaining <= 0) break;
    const text = span.text.slice(0, remaining);
    result.push(span.redacted ? { text, redacted: true } : { text });
    remaining -= text.length;
  }
  return result;
}

/** Pure analysis: no URL fetch, HTML execution, attachments or recipient output. */
export function renderHeldMessageReview(
  subject: string,
  body: { html: string | null; text: string | null },
): { subject: RevealSpan[]; spans: RevealSpan[]; redactions: number; linkHosts: string[] } {
  const renderedSubject = redactRevealedText(subject.slice(0, 2_000));
  const renderedBody = renderRevealedBody(body);
  const safeSubject = transportSpans(renderedSubject.spans);
  const safeBody = transportSpans(renderedBody.spans);
  const subjectSpans = boundedSpans(safeSubject.spans, 2_000);
  const bodySpans = boundedSpans(
    safeBody.spans,
    20_000 - subjectSpans.reduce((sum, span) => sum + span.text.length, 0),
  );
  const hosts = new Set<string>();
  // Inspect strings only. Includes href/src destinations absent from visible text.
  for (const part of [body.html ?? "", body.text ?? ""]) {
    for (const match of decodeEntities(part).matchAll(URLS)) {
      try {
        const raw = match[0];
        const url = new URL(
          raw.startsWith("//")
            ? `https:${raw}`
            : /^https?:\/\//i.test(raw)
              ? raw
              : `https://${raw}`,
        );
        const literal = isIpLiteral(url.hostname);
        const host = literal
          ? url.hostname.replace(/^\[|\]$/g, "")
          : registrableDomain(url.hostname);
        if (literal || /^[a-z0-9.-]{1,253}$/i.test(host)) hosts.add(host.toLowerCase());
      } catch {
        // Invalid destinations cannot become active links in the text-only view.
      }
    }
  }
  return {
    subject: subjectSpans,
    spans: bodySpans,
    redactions: [...subjectSpans, ...bodySpans].filter((span) => span.redacted).length,
    linkHosts: [...hosts].sort().slice(0, 30),
  };
}
