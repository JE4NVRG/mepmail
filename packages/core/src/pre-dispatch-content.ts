import { createHash } from "node:crypto";
import {
  buildJudgeBlock,
  JUDGE_LINK_ROWS_MAX,
  JUDGE_TEXT_MAX_CHARS,
  type JudgeBlockInput,
  stripHiddenElements,
} from "./abuse-judge/block.js";
import { JUDGE_VERDICT_NOUL } from "./abuse-judge/questions.js";
import { type AbuseJudge, type JudgeVerdict, judgeErrorClass } from "./abuse-judge/types.js";

export const PRE_DISPATCH_TIMEOUT_MS = 20_000;
export interface DispatchContentSnapshot {
  teamId: string;
  emailId: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  replyTo: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  attachments: boolean;
  /** Exact final MIME bytes; no approval survives a transformation. */
  mime: Buffer;
}
export type DispatchContentDecision =
  | { allowed: true; fingerprint: string; verdict: JudgeVerdict }
  | { allowed: false; reason: string; verdict?: JudgeVerdict };

export function dispatchContentFingerprint(s: DispatchContentSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...s, mime: s.mime.toString("base64") }))
    .digest("hex");
}

function inspectable(s: DispatchContentSnapshot): boolean {
  // The existing text/domain judge is not a vision, attachment or MIME scanner.
  // Refuse inputs its unchanged projection would omit/truncate, not fake CLEAN.
  if (s.attachments || (!s.html && !s.text)) return false;
  if (
    [s.html ?? "", s.text ?? "", s.subject, s.from, ...(s.replyTo ?? [])].some(
      (v) => v.length > JUDGE_TEXT_MAX_CHARS,
    )
  )
    return false;
  if (s.html) {
    if (
      /<(?:img|svg|canvas|video|audio|iframe|object|embed|script|style|form|input|meta|link|base)\b|<!--|\bhidden\b|url\s*\(/i.test(
        s.html,
      )
    )
      return false;
    if (
      stripHiddenElements(s.html).html !== s.html ||
      /\s(?:style|src|srcset|background|poster|on[a-z]+)\s*=/i.test(s.html)
    )
      return false;
    if (
      [...s.html.matchAll(/<\/?([a-z][a-z0-9-]*)\b/gi)].some(
        (t) =>
          !/^(?:p|div|span|br|b|strong|em|i|u|ul|ol|li|table|tbody|thead|tr|td|th|h[1-6]|a|hr)$/i.test(
            t[1]!,
          ),
      )
    )
      return false;
    const tags = [...s.html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^<>]*>/gi)];
    if (/[<>]/.test(s.html.replace(/<\/?([a-z][a-z0-9]*)\b[^<>]*>/gi, ""))) return false;
    const stack: string[] = [];
    for (const tag of tags) {
      const name = tag[1]!.toLowerCase();
      if (name === "br" || name === "hr") continue;
      if (tag[0].startsWith("</")) {
        if (stack.pop() !== name) return false;
      } else {
        if (name === "a" && stack.includes("a")) return false;
        stack.push(name);
      }
    }
    if (stack.length) return false;
    const anchors = [
      ...s.html.matchAll(
        /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      ),
    ];
    if (
      anchors.length !== tags.filter((t) => /^<a\b/i.test(t[0])).length ||
      anchors.length > JUDGE_LINK_ROWS_MAX ||
      anchors.some(
        (a) =>
          a[4]!.replace(/<[^>]*>/g, "").length > 80 ||
          !/^https?:\/\//i.test(a[1] ?? a[2] ?? a[3] ?? ""),
      )
    )
      return false;
  }
  return true;
}

function validVerdict(v: unknown): v is JudgeVerdict {
  if (!v || typeof v !== "object") return false;
  const x = v as JudgeVerdict;
  return (
    Number.isFinite(x.score) &&
    x.score >= 0 &&
    x.score <= 100 &&
    (x.verdict === "clean" || x.verdict === "abuse") &&
    Array.isArray(x.categories) &&
    x.categories.every((v) => typeof v === "string") &&
    Array.isArray(x.reasons) &&
    x.reasons.every((v) => typeof v === "string") &&
    (x.impersonatedBrand === null || typeof x.impersonatedBrand === "string") &&
    typeof x.language === "string" &&
    x.language.length > 0
  );
}

/** No persistence of content or authority: each dispatch qualifies its exact snapshot. */
export async function qualifyDispatchContent(
  snapshot: DispatchContentSnapshot,
  context: JudgeBlockInput["team"],
  judge: AbuseJudge | null | undefined,
  signal: AbortSignal = AbortSignal.timeout(PRE_DISPATCH_TIMEOUT_MS),
): Promise<DispatchContentDecision> {
  if (!judge) return { allowed: false, reason: "off" };
  if (!inspectable(snapshot)) return { allowed: false, reason: "uninspectable" };
  const fingerprint = dispatchContentFingerprint(snapshot);
  const blocks = new Set<string>();
  const base = {
    team: context,
    from: snapshot.from,
    replyTo: snapshot.replyTo,
    subject: snapshot.subject,
    attachments: [],
  };
  // Multipart alternatives are independent author-controlled content. Neither
  // an innocuous HTML alternative nor skeleton approval clears hostile text.
  if (snapshot.html) blocks.add(buildJudgeBlock({ ...base, html: snapshot.html, text: null }));
  if (snapshot.text) blocks.add(buildJudgeBlock({ ...base, html: null, text: snapshot.text }));
  let last: JudgeVerdict | undefined;
  try {
    for (const block of blocks) {
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      let verdict: JudgeVerdict;
      try {
        verdict = await Promise.race([
          judge.judge(block, { signal }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (!validVerdict(verdict)) return { allowed: false, reason: "parse_error" };
      if (
        verdict.verdict !== "clean" ||
        verdict.score >= JUDGE_VERDICT_NOUL * 100 ||
        verdict.categories.length > 0 ||
        verdict.reasons.length > 0 ||
        verdict.impersonatedBrand !== null
      )
        return { allowed: false, reason: "content", verdict };
      if (!last || verdict.score > last.score) last = verdict;
    }
  } catch (error) {
    return { allowed: false, reason: judgeErrorClass(error) };
  }
  if (!last || signal.aborted) return { allowed: false, reason: "inconclusive" };
  if (dispatchContentFingerprint(snapshot) !== fingerprint)
    return { allowed: false, reason: "snapshot_changed" };
  return { allowed: true, fingerprint, verdict: last };
}
