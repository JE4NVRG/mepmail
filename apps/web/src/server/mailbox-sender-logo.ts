import { lookup as dnsLookup } from "node:dns";
import { resolveTxt } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { isBlockedIp } from "@millionsend/core";
import { organizationalDomain } from "../lib/mailbox-sender-logo";

/**
 * Sender pictures for the Correio: the brand's BIMI logo (DNS TXT default._bimi.<domain>,
 * then its organizational domain), the person's Gravatar, or the brand website's icon.
 * Only what a server-signed token allows is looked up (server/mailbox-sender-picture.ts:
 * mail that passed DMARC, BIMI under an enforced policy). This side fetches from the
 * open internet, so every request is the webhook client's discipline: https only,
 * the resolved address checked and pinned (no rebinding), redirects few and re-checked,
 * small bodies, short timeouts, and the bytes typed by their own signature, never by the
 * server's word. SVG is served only when it carries nothing active.
 */

export interface SenderLogo {
  contentType: string;
  body: Buffer;
}

const MAX_IMAGE_BYTES = 128 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4_000;
const RESOLVE_BUDGET_MS = 9_000;
const MAX_REDIRECTS = 3;
const FOUND_TTL_MS = 24 * 3_600_000;
const MISSING_TTL_MS = 6 * 3_600_000;
const CACHE_ENTRIES = 1_000;
const USER_AGENT = "MepMail-Logo/1.0 (+https://mepmail.dev)";

interface Fetched {
  status: number;
  body: Buffer;
  location: string | null;
  contentType: string;
}

export interface SenderLogoDeps {
  resolveTxt: (name: string) => Promise<string[][]>;
  /** One GET, no redirects followed; resolves for any completed HTTP exchange. */
  get: (url: URL, maxBytes: number, signal: AbortSignal) => Promise<Fetched>;
}

/** GET through a lookup that refuses private/reserved addresses and pins the checked one. */
function pinnedGet(url: URL, maxBytes: number, signal: AbortSignal): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== "https:") return reject(new Error("logo url must be https"));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) return reject(new Error("logo url must name a host"));
    const lookup = ((
      name: string,
      options: { all?: boolean },
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number,
      ) => void,
    ) => {
      dnsLookup(name, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return cb(err, "", 0);
        if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address)))
          return cb(new Error("logo host resolves to a blocked address"), "", 0);
        if (options?.all === true) return cb(null, addresses);
        const [first] = addresses;
        if (!first) return cb(new Error("logo host did not resolve"), "", 0);
        cb(null, first.address, first.family);
      });
    }) as typeof dnsLookup;
    const request = https.request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: { "user-agent": USER_AGENT, accept: "image/*,text/html;q=0.8,*/*;q=0.1" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            location:
              typeof response.headers.location === "string" ? response.headers.location : null,
            contentType: String(response.headers["content-type"] ?? ""),
          });
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Too big to be an icon (or a page worth reading): stop here.
            response.destroy();
            reject(new Error("logo response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", done);
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const defaultDeps: SenderLogoDeps = { resolveTxt, get: pinnedGet };

/** Follows a few redirects, each one https and checked again by the pinned lookup. */
async function fetchFollowing(
  deps: SenderLogoDeps,
  start: URL,
  maxBytes: number,
  deadline: AbortSignal,
): Promise<{ url: URL; response: Fetched } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await deps.get(url, maxBytes, signal);
    if (response.status >= 300 && response.status < 400 && response.location) {
      const next = new URL(response.location, url);
      if (next.protocol !== "https:") return null;
      url = next;
      continue;
    }
    return response.status === 200 ? { url, response } : null;
  }
  return null;
}

/** The image type by its first bytes; null for anything that is not an image we serve. */
export function sniffImage(body: Buffer): string | null {
  if (body.length < 32) return null;
  if (body[0] === 0x89 && body.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return "image/x-icon";
  const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (
    (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!--")) &&
    safeSvg(body)
  )
    return "image/svg+xml";
  return null;
}

/** SVG with nothing active in it: no script, handlers, foreign content or remote references. */
export function safeSvg(body: Buffer): boolean {
  const text = body.toString("utf8");
  if (!/<svg[\s>]/i.test(text)) return false;
  return !(
    /<script|<foreignobject|<iframe|<embed|<object|<!entity/i.test(text) ||
    /\son[a-z]+\s*=/i.test(text) ||
    /javascript:|data:text\/html/i.test(text) ||
    /(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i.test(text)
  );
}

/** The https logo URL a domain's BIMI record names (v=BIMI1; l=…), if any. */
async function bimiLogoUrl(deps: SenderLogoDeps, domain: string): Promise<URL | null> {
  let records: string[][];
  try {
    records = await deps.resolveTxt(`default._bimi.${domain}`);
  } catch {
    return null;
  }
  for (const parts of records) {
    const record = parts.join("");
    if (!/^v=BIMI1\s*;/i.test(record)) continue;
    const location = /(?:^|;)\s*l=([^;]*)/i.exec(record)?.[1]?.trim();
    if (!location) return null;
    try {
      const url = new URL(location);
      return url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Icon links a home page declares, best first (apple-touch-icon, then larger icons). */
export function iconLinks(html: string, base: URL): URL[] {
  const found: { url: URL; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\b(?:icon|apple-touch-icon(?:-precomposed)?)\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes("apple-touch-icon") ? 1_000 : 0) + Math.min(size, 512);
    found.push({ url, score });
  }
  return found.sort((a, b) => b.score - a.score).map((entry) => entry.url);
}

async function image(
  deps: SenderLogoDeps,
  url: URL,
  deadline: AbortSignal,
  svgOnly = false,
): Promise<SenderLogo | null> {
  try {
    const fetched = await fetchFollowing(deps, url, MAX_IMAGE_BYTES, deadline);
    if (!fetched) return null;
    const type = sniffImage(fetched.response.body);
    if (!type || (svgOnly && type !== "image/svg+xml")) return null;
    return { contentType: type, body: fetched.response.body };
  } catch {
    return null;
  }
}

/** A website's icon: what its home page declares, then the conventional paths. */
async function favicon(
  deps: SenderLogoDeps,
  domain: string,
  deadline: AbortSignal,
): Promise<SenderLogo | null> {
  const home = new URL(`https://${domain}/`);
  const candidates: URL[] = [];
  try {
    const page = await fetchFollowing(deps, home, MAX_PAGE_BYTES, deadline);
    if (page && /html/i.test(page.response.contentType))
      candidates.push(...iconLinks(page.response.body.toString("utf8"), page.url).slice(0, 2));
  } catch {
    // No home page (or not reachable): the conventional paths below may still answer.
  }
  candidates.push(new URL("/apple-touch-icon.png", home), new URL("/favicon.ico", home));
  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url.href) || deadline.aborted) continue;
    seen.add(url.href);
    const found = await image(deps, url, deadline);
    if (found) return found;
  }
  return null;
}

const cache = new Map<string, { expires: number; logo: SenderLogo | null }>();
const pending = new Map<string, Promise<SenderLogo | null>>();

function remember(key: string, logo: SenderLogo | null) {
  cache.delete(key);
  cache.set(key, { expires: Date.now() + (logo ? FOUND_TTL_MS : MISSING_TTL_MS), logo });
  while (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

class OverBudget extends Error {}

/**
 * One cached lookup (a BIMI logo, a Gravatar, a website icon). A miss asks the budget
 * first: a person scrolling through new senders cannot make this server fetch without
 * limit. Answers, found or not, are kept so a busy inbox asks the internet once.
 */
async function lookup(
  key: string,
  budget: () => boolean,
  work: () => Promise<SenderLogo | null>,
): Promise<SenderLogo | null> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.logo;
  const running = pending.get(key);
  if (running) return running;
  if (!budget()) throw new OverBudget();
  const job = work()
    .catch(() => null)
    .then((logo) => {
      remember(key, logo);
      return logo;
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** What the signed token allows to look up (server/mailbox-sender-picture.ts). */
export interface SenderPictureRequest {
  /** Brand domain; null for personal mail services. */
  domain: string | null;
  /** The message passed DMARC under an enforced policy: the brand's BIMI logo may win. */
  bimi: boolean;
  /** sha256 of the sender's address. */
  gravatar: string | null;
}

/**
 * The picture for a sender, or null: the brand's BIMI logo (when allowed), the person's
 * Gravatar, then the brand website's icon. `limited` is true when the budget stopped an
 * uncached lookup (nothing is remembered then; a later view may try again).
 */
export async function resolveSenderPicture(
  request: SenderPictureRequest,
  options: { budget?: () => boolean } = {},
  deps: SenderLogoDeps = defaultDeps,
): Promise<{ logo: SenderLogo | null; limited: boolean }> {
  const budget = options.budget ?? (() => true);
  const deadline = () => AbortSignal.timeout(RESOLVE_BUDGET_MS);
  try {
    const domain = request.domain;
    const org = domain ? organizationalDomain(domain) : null;
    if (domain && request.bimi) {
      const logo = await lookup(`b:${domain}`, budget, async () => {
        const signal = deadline();
        for (const name of [...new Set([domain, org as string])]) {
          const url = await bimiLogoUrl(deps, name);
          if (url) return image(deps, url, signal, true);
        }
        return null;
      });
      if (logo) return { logo, limited: false };
    }
    if (request.gravatar) {
      const hash = request.gravatar;
      const logo = await lookup(`g:${hash}`, budget, () =>
        image(deps, new URL(`https://gravatar.com/avatar/${hash}?d=404&s=96`), deadline()),
      );
      if (logo) return { logo, limited: false };
    }
    if (domain && org) {
      // The brand's site is usually the organizational domain (mail.x.com has none).
      const logo = await lookup(`f:${org}`, budget, async () => {
        const signal = deadline();
        for (const name of [...new Set([org, domain])]) {
          if (signal.aborted) break;
          const found = await favicon(deps, name, signal);
          if (found) return found;
        }
        return null;
      });
      if (logo) return { logo, limited: false };
    }
    return { logo: null, limited: false };
  } catch (error) {
    if (error instanceof OverBudget) return { logo: null, limited: true };
    return { logo: null, limited: false };
  }
}

/** Tests only: forget every cached answer. */
export function clearSenderLogoCache() {
  cache.clear();
  pending.clear();
}
