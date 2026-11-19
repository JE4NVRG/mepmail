"use client";

import { type MutableRefObject, useCallback, useEffect, useRef } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/* Global Turnstile calls once the API is usable: the supported "ready" signal
   for a script added at runtime (turnstile.ready() throws for async tags). */
const ONLOAD_CALLBACK = "__mepmailTurnstileLoaded";
/* A token request that never settles must fail visibly, not hang the button. */
const TOKEN_TIMEOUT_MS = 30_000;
const SCRIPT_TIMEOUT_MS = 15_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance: "interaction-only";
      action?: string;
      callback: (token: string) => void;
      "error-callback": (code?: string) => void;
      "expired-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoading: Promise<TurnstileApi> | undefined;
/** Loads the API once and resolves when Turnstile calls back that it is usable. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("turnstile"));
    };
    const timer = window.setTimeout(fail, SCRIPT_TIMEOUT_MS);
    (window as unknown as Record<string, unknown>)[ONLOAD_CALLBACK] = () => {
      window.clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.src = `${SCRIPT_URL}&onload=${ONLOAD_CALLBACK}`;
    script.async = true;
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // A network failure must allow the person's next click to retry loading.
    scriptLoading = undefined;
    throw error;
  });
  return scriptLoading;
}

type TokenWaiter = {
  resolve: (token: string) => void;
  reject: () => void;
};

/**
 * Publica a espera do próximo token antes de pedir o desafio e falha visível
 * quando o prazo estoura: um pedido que nunca responde não pode travar o botão.
 */
function waitForToken(
  pending: MutableRefObject<TokenWaiter | null>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("turnstile"));
    const timer = window.setTimeout(fail, timeoutMs);
    pending.current = {
      resolve: (token) => {
        window.clearTimeout(timer);
        pending.current = null;
        resolve(token);
      },
      reject: () => {
        window.clearTimeout(timer);
        pending.current = null;
        fail();
      },
    };
  });
}

/**
 * Cloudflare Turnstile behind a form: a widget that only shows up when
 * Cloudflare needs an interaction, handing back a fresh token per submit.
 * The widget is rendered lazily, on the first token request, because the
 * slot may mount well after the hook (a button that appears once data
 * loads); the script itself is fetched as soon as the hook mounts. With no
 * site key (the instance opted out) `getToken` resolves null and the slot
 * stays empty, so callers never branch on configuration.
 */
export function useTurnstile(siteKey: string | null, action?: string) {
  const slotRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // The element the widget was rendered into: a screen that swaps its form
  // for a notice mounts a fresh slot, and a widget in a detached div never
  // answers, so the next token request renders again.
  const renderedIn = useRef<HTMLElement | null>(null);
  const pending = useRef<{ resolve: (token: string) => void; reject: () => void } | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    void loadTurnstile().catch(() => {});
    return () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (!siteKey) return null;
    const turnstile = await loadTurnstile();
    if (widgetId.current && renderedIn.current !== slotRef.current) {
      turnstile.remove(widgetId.current);
      widgetId.current = null;
    }
    // A espera é publicada antes de renderizar ou resetar: um widget
    // "managed" pode entregar o token no mesmo tick do render, e uma promessa
    // criada depois perderia a resposta (o botão ficava 30 s em "enviando…"
    // e caía em "A verificação falhou").
    const waiting = waitForToken(pending, TOKEN_TIMEOUT_MS);
    if (!widgetId.current) {
      const slot = slotRef.current;
      if (!slot) throw new Error("turnstile");
      renderedIn.current = slot;
      widgetId.current = turnstile.render(slot, {
        sitekey: siteKey,
        // Sem `execution: "execute"`: esse modo só vale para widget
        // invisível. Num widget "managed" ele impede o desafio interativo de
        // aparecer, e quem o Cloudflare sinaliza como risco fica sem token.
        appearance: "interaction-only",
        ...(action ? { action } : {}),
        callback: (token) => pending.current?.resolve(token),
        "error-callback": (code) => {
          // Cloudflare's code (e.g. 110200 = hostname not on the widget) is
          // the one clue an operator gets; keep it visible.
          console.warn("Turnstile error", code);
          pending.current?.reject();
        },
        "expired-callback": () => pending.current?.reject(),
      });
      return waiting;
    }
    turnstile.reset(widgetId.current);
    return waiting;
  }, [siteKey, action]);

  return { slot: <div ref={slotRef} />, getToken };
}

/** Better Auth's captcha plugin reads the token from this header. */
export function captchaHeaders(token: string | null): Record<string, string> {
  return token ? { "x-captcha-response": token } : {};
}
