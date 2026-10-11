/**
 * "Traduzir" in the Correio reader uses the browser's own translator (Chrome's
 * Translator and LanguageDetector APIs): the message is translated on the
 * person's computer and never leaves it. Where the browser has no translator
 * (other browsers, the desktop app's webview today) the button is not offered.
 */

export type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

type Monitor = (monitor: EventTarget) => void;

export interface BrowserTranslator {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}
interface TranslatorFactory {
  availability(languages: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: Monitor;
  }): Promise<BrowserTranslator>;
}
interface LanguageDetectorFactory {
  create(options?: { monitor?: Monitor }): Promise<{
    detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>;
    destroy?: () => void;
  }>;
}

/** The browser's translator (and language detector, when there is one), or null. */
export function browserTranslation(): {
  translator: TranslatorFactory;
  detector: LanguageDetectorFactory | null;
} | null {
  const scope = globalThis as {
    Translator?: Partial<TranslatorFactory>;
    LanguageDetector?: Partial<LanguageDetectorFactory>;
  };
  const translator = scope.Translator;
  if (!translator || typeof translator.create !== "function") return null;
  if (typeof translator.availability !== "function") return null;
  const detector =
    scope.LanguageDetector && typeof scope.LanguageDetector.create === "function"
      ? (scope.LanguageDetector as LanguageDetectorFactory)
      : null;
  return { translator: translator as TranslatorFactory, detector };
}

/** The language a translation goes to: the page's ("pt-BR" → "pt"). */
export function translationTarget(locale: string): string {
  return (locale.split("-")[0] ?? "en").toLowerCase() || "en";
}

/** Same language family ("pt" and "pt-PT", "en-US" and "en"). */
export function sameLanguage(a: string, b: string): boolean {
  return translationTarget(a) === translationTarget(b);
}

/**
 * The text in pieces the translator takes one at a time, keeping paragraphs:
 * short ones join up to `max` characters, a long one splits at sentence ends
 * (or, failing that, at `max`). Blank paragraphs are dropped.
 */
export function translationChunks(text: string, max = 1800): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      pieces.push(paragraph);
      continue;
    }
    let current = "";
    for (const sentence of paragraph.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [paragraph]) {
      if (current && current.length + sentence.length > max) {
        pieces.push(current.trim());
        current = "";
      }
      if (sentence.length > max) {
        for (let start = 0; start < sentence.length; start += max)
          pieces.push(sentence.slice(start, start + max).trim());
        continue;
      }
      current += sentence;
    }
    if (current.trim()) pieces.push(current.trim());
  }
  // Join neighbours while they fit, so a short email is one or two calls.
  const joined: string[] = [];
  for (const piece of pieces) {
    const last = joined.at(-1);
    if (last !== undefined && last.length + piece.length + 2 <= max)
      joined[joined.length - 1] = `${last}\n\n${piece}`;
    else joined.push(piece);
  }
  return joined.filter(Boolean);
}
