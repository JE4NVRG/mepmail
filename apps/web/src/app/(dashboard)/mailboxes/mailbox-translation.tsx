"use client";

import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type BrowserTranslator,
  browserTranslation,
  sameLanguage,
  translationChunks,
  translationTarget,
} from "@/lib/mailbox-translation";
import styles from "./mailboxes.module.css";

type State =
  | { step: "idle" }
  | { step: "working"; percent: number | null }
  | { step: "done"; from: string; paragraphs: string[]; showing: "translation" | "original" }
  | { step: "notice"; message: string };

/**
 * "Traduzir" above a message: the browser's own translator (lib/mailbox-translation)
 * turns the message's text into the page's language on this computer. The first
 * time a language pair is used the browser downloads it (with progress); later
 * ones are instant. The translation replaces the body until "Mostrar original".
 * Offered only where the browser has a translator.
 */
export function MailboxTranslation({ text, children }: { text: string; children: ReactNode }) {
  const t = useTranslations("mailboxes.translate");
  const locale = useLocale();
  const target = translationTarget(locale);
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<State>({ step: "idle" });
  const translator = useRef<BrowserTranslator | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setAvailable(browserTranslation() !== null && text.trim().length > 0);
    return () => {
      alive.current = false;
      translator.current?.destroy?.();
      translator.current = null;
    };
  }, [text]);
  const languageName = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  async function translate() {
    const api = browserTranslation();
    if (!api || state.step === "working") return;
    setState({ step: "working", percent: null });
    const progress = (monitor: EventTarget) =>
      monitor.addEventListener("downloadprogress", (event) => {
        const loaded = (event as Event & { loaded?: number }).loaded;
        if (alive.current && typeof loaded === "number")
          setState({ step: "working", percent: Math.round(loaded * 100) });
      });
    try {
      // The language the message is in; without a detector, English (the usual case).
      let from = "en";
      if (api.detector) {
        const detector = await api.detector.create({ monitor: progress });
        const [best] = await detector.detect(text.slice(0, 4000));
        detector.destroy?.();
        if (best && best.confidence >= 0.4 && best.detectedLanguage !== "und")
          from = best.detectedLanguage;
      }
      if (!alive.current) return;
      if (sameLanguage(from, target)) {
        setState({ step: "notice", message: t("same", { language: languageName(target) }) });
        return;
      }
      const languages = { sourceLanguage: translationTarget(from), targetLanguage: target };
      if ((await api.translator.availability(languages)) === "unavailable") {
        setState({
          step: "notice",
          message: t("unavailable", { from: languageName(from), to: languageName(target) }),
        });
        return;
      }
      translator.current?.destroy?.();
      translator.current = await api.translator.create({ ...languages, monitor: progress });
      const paragraphs: string[] = [];
      for (const chunk of translationChunks(text)) {
        const translated = await translator.current.translate(chunk);
        if (!alive.current) return;
        paragraphs.push(...translated.split(/\n{2,}/));
        // Long messages fill in as they go.
        setState({ step: "done", from, paragraphs: [...paragraphs], showing: "translation" });
      }
    } catch {
      if (alive.current) setState({ step: "notice", message: t("failed") });
    }
  }

  if (!available) return <>{children}</>;
  const translated = state.step === "done" && state.showing === "translation";
  return (
    <>
      <p className={styles.translateBar}>
        {state.step === "done" ? (
          <>
            <span>
              {translated
                ? t("banner", { language: languageName(state.from) })
                : t("originalBanner", { language: languageName(state.from) })}
            </span>
            <button
              type="button"
              className="ms-btn ms-btn-ghost ms-btn-sm"
              onClick={() =>
                setState({
                  ...state,
                  showing: state.showing === "translation" ? "original" : "translation",
                })
              }
            >
              {translated ? t("showOriginal") : t("showTranslation")}
            </button>
          </>
        ) : state.step === "working" ? (
          <span role="status">
            {state.percent !== null && state.percent < 100
              ? t("downloading", { percent: state.percent })
              : t("working")}
          </span>
        ) : (
          <>
            {state.step === "notice" ? <span role="status">{state.message}</span> : null}
            <button
              type="button"
              className="ms-btn ms-btn-ghost ms-btn-sm"
              onClick={() => void translate()}
              title={t("hint")}
            >
              {t("button", { language: languageName(target) })}
            </button>
          </>
        )}
      </p>
      {translated ? (
        <div className={styles.translatedBody} lang={target}>
          {state.paragraphs.map((paragraph, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one translation, in order
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : (
        children
      )}
    </>
  );
}
