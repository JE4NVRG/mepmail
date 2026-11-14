import { createHash } from "node:crypto";
import {
  buildJudgeBlock,
  JUDGE_TEXT_MAX_CHARS,
  type JudgeBlockInput,
} from "./abuse-judge/block.js";
import { JUDGE_VERDICT_NOUL } from "./abuse-judge/questions.js";
import { type AbuseJudge, type JudgeVerdict, judgeErrorClass } from "./abuse-judge/types.js";
import { hasUnsafeDispatchCharacters, projectDispatchHtml } from "./dispatch-html-projection.js";
import { type RewriteOptions, rewriteForTracking } from "./link-tracking.js";

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
  sourceHtml: string | null;
  sourceText: string | null;
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

// Capability custody is module-private and snapshot-object-bound. Public tags,
// serialized fields, source image sizes or tracking-looking URLs grant nothing.
const trackingProjections = new WeakMap<
  DispatchContentSnapshot,
  {
    fingerprint: string;
    before: string;
    finalWithoutPixel: string;
  }
>();

/** Internal worker boundary: use ONLY the exact server-owned rewrite options. */
export function bindDispatchTracking(
  snapshot: DispatchContentSnapshot,
  before: string,
  options: RewriteOptions,
): void {
  trackingProjections.delete(snapshot);
  if (
    options.emailId !== snapshot.emailId ||
    !options.open ||
    projectDispatchHtml(before) === null ||
    rewriteForTracking(before, options) !== snapshot.html
  )
    return;
  // Regenerate from the inspected preimage, never remove an img by pattern.
  // Source images remain unsupported, even a copied valid signed 1x1 pixel.
  const finalWithoutPixel = rewriteForTracking(before, { ...options, open: false });
  if (projectDispatchHtml(finalWithoutPixel) === null) return;
  trackingProjections.set(snapshot, {
    fingerprint: dispatchContentFingerprint(snapshot),
    before,
    finalWithoutPixel,
  });
}

function projectionBlocks(s: DispatchContentSnapshot): string[] | null {
  if (s.attachments || (!s.html && !s.text)) return null;
  if (
    [s.text ?? "", s.sourceText ?? "", s.subject, s.from, ...(s.replyTo ?? [])].some(
      (value) => value.length > JUDGE_TEXT_MAX_CHARS || hasUnsafeDispatchCharacters(value),
    )
  )
    return null;
  const proof = trackingProjections.get(s);
  if (proof && dispatchContentFingerprint(s) !== proof.fingerprint) return null;
  const blocks: string[] = [];
  for (const html of [
    s.sourceHtml,
    ...(proof ? [proof.before] : []),
    proof?.finalWithoutPixel ?? s.html,
  ]) {
    if (!html) continue;
    const text = projectDispatchHtml(html);
    if (text === null) return null;
    blocks.push(text);
  }
  for (const text of [s.sourceText, s.text]) if (text) blocks.push(text);
  return blocks.length ? blocks : null;
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
  const projections = projectionBlocks(snapshot);
  if (!projections) return { allowed: false, reason: "uninspectable" };
  const fingerprint = dispatchContentFingerprint(snapshot);
  const blocks = new Set<string>();
  const base = {
    team: context,
    from: snapshot.from,
    replyTo: snapshot.replyTo,
    subject: snapshot.subject,
    attachments: [],
  };
  // Same judge/prompt/rubric. The bounded text projection retains every text
  // node, every alternative, and complete original AND final href bytes.
  for (const text of projections) blocks.add(buildJudgeBlock({ ...base, html: null, text }));
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
