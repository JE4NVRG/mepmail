"use client";

import { useEffect, useState } from "react";

type Tone = "success" | "info" | "warn" | "danger" | "neutral";

/** A button inside the toast, such as "Desfazer"; it closes the toast. */
export type ToastAction = { label: string; run: () => void };

interface ToastRequest {
  id: number;
  message: string;
  tone: Tone;
  action?: ToastAction;
  durationMs: number;
}

/* Imperative bridge like confirm-dialog.tsx: callable from event handlers
   without threading context. The host renders whichever toast is showing. */
let listener: ((request: ToastRequest) => void) | null = null;
let nextId = 1;

const TOAST_MS = 3_200;
/** Long enough to reach an action button. */
const ACTION_MS = 8_000;

/** A transient bottom-center notice; falls back to nothing when no host is mounted. */
export function toast(
  message: string,
  tone: Tone = "success",
  options: { action?: ToastAction; durationMs?: number } = {},
): void {
  listener?.({
    id: nextId++,
    message,
    tone,
    ...(options.action ? { action: options.action } : {}),
    durationMs: options.durationMs ?? (options.action ? ACTION_MS : TOAST_MS),
  });
}

const ICON: Record<Tone, string> = {
  success: "✓",
  info: "i",
  warn: "!",
  danger: "✕",
  neutral: "·",
};

export function ToastHost() {
  const [current, setCurrent] = useState<ToastRequest | null>(null);
  useEffect(() => {
    listener = setCurrent;
    return () => {
      listener = null;
    };
  }, []);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(null), current.durationMs);
    return () => clearTimeout(timer);
  }, [current]);
  if (!current) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: "var(--ms-z-menu)",
        // Centered by left/transform, a shrink-to-fit box would stop at half the
        // screen and wrap short messages on a phone.
        width: "max-content",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <div role="status" className={`ms-toast ms-toast-${current.tone}`}>
        <span className="ms-toast-icon" aria-hidden="true">
          {ICON[current.tone]}
        </span>
        <span>{current.message}</span>
        {current.action ? (
          <button
            type="button"
            className="ms-btn ms-btn-ghost ms-btn-sm"
            style={{ marginLeft: 8, color: "inherit", fontWeight: 600 }}
            onClick={() => {
              const action = current.action;
              setCurrent(null);
              action?.run();
            }}
          >
            {current.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
