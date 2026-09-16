/**
 * The content monitor's judge: one interface, three adapters in the worker.
 * A verdict is the model's JSON answer to the rubric; every failure is a
 * JudgeError with a class the sample records as "unjudged". Nothing here
 * touches sending.
 */

export const JUDGE_PROVIDERS = ["bedrock", "openai", "anthropic"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

export interface JudgeVerdict {
  /** 0–100, 100 = certainly abusive. */
  score: number;
  verdict: "abuse" | "clean";
  categories: string[];
  impersonatedBrand: string | null;
  /** Short reason codes, at most a handful. */
  reasons: string[];
  language: string;
}

export interface AbuseJudge {
  readonly provider: JudgeProvider;
  readonly model: string;
  judge(block: string, opts: { signal: AbortSignal }): Promise<JudgeVerdict>;
}

/**
 * Why a sample went unjudged. `off`, `no_credentials`, `throttled`,
 * `timeout`, `upstream` and `parse_error` are the judge's; `body_purged`
 * means retention removed the body first, `lost` that the job never ran.
 */
export const JUDGE_ERROR_CLASSES = [
  "off",
  "no_credentials",
  "throttled",
  "timeout",
  "upstream",
  "parse_error",
  "body_purged",
  "lost",
] as const;
export type JudgeErrorClass = (typeof JUDGE_ERROR_CLASSES)[number];

export class JudgeError extends Error {
  readonly class: JudgeErrorClass;
  constructor(errorClass: JudgeErrorClass, message?: string, options?: { cause?: unknown }) {
    super(message ?? errorClass, options);
    this.name = "JudgeError";
    this.class = errorClass;
  }
}

/** The class of any error a judge call threw: its own, an abort, or an upstream fault. */
export function judgeErrorClass(err: unknown): JudgeErrorClass {
  if (err instanceof JudgeError) return err.class;
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "upstream";
}

const MAX_LIST = 5;
const MAX_LABEL = 40;
const MAX_BRAND = 60;

/**
 * Reason and category codes, normalised to snake_case tokens: the row and
 * the console hold codes, never a sentence the model may have quoted from
 * the mail. Anything that does not reduce to a token is dropped.
 */
function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const code = v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_LABEL);
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** The first `{ … }` in `text` that parses, tolerating a code fence before it and prose after it. */
function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Not JSON from here; try the next opening brace.
    }
  }
  return null;
}

/** The index of the brace closing the object opened at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The model's answer as a verdict. Models wrap the JSON in a fence or add a
 * sentence after it; the first object that parses wins. A missing or
 * non-numeric score is a parse error; the rest degrades to empty lists.
 */
export function parseJudgeOutput(text: string): JudgeVerdict {
  const obj = firstJsonObject(text.replace(/```(?:json)?/gi, ""));
  if (obj === null || typeof obj !== "object")
    throw new JudgeError("parse_error", "no JSON object");
  const raw = obj as Record<string, unknown>;
  // Only a number or a numeric string: Number() would read null, true or [] as a score.
  const score =
    typeof raw.score === "number"
      ? raw.score
      : typeof raw.score === "string" && raw.score.trim() !== ""
        ? Number(raw.score)
        : Number.NaN;
  if (!Number.isFinite(score)) throw new JudgeError("parse_error", "no numeric score");
  const clamped = Math.round(Math.min(100, Math.max(0, score)));
  const verdict =
    raw.verdict === "abuse" || raw.verdict === "clean"
      ? raw.verdict
      : clamped >= 65
        ? "abuse"
        : "clean";
  const brand =
    typeof raw.impersonated_brand === "string"
      ? raw.impersonated_brand.replace(/\s+/g, " ").trim().slice(0, MAX_BRAND)
      : "";
  return {
    score: clamped,
    verdict,
    categories: labels(raw.categories),
    impersonatedBrand: brand || null,
    reasons: labels(raw.reasons),
    language: typeof raw.language === "string" ? raw.language.slice(0, 16) : "other",
  };
}
