"use client";

import { type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";

/**
 * The Correio on a phone: a row swiped sideways is archived, a long press selects it and
 * the list pulled down past its top refreshes. Only touch input does any of this; a mouse
 * or a pen keeps the desktop behaviour (drag to folders, checkboxes, the refresh button).
 */

/** Whether the main input is a finger (no hover, coarse pointer): the phone gestures apply. */
export function useTouchInput(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return touch;
}

const LONG_PRESS_MS = 480;
/** Movement (px) that still counts as holding still, and that decides a direction. */
const SLOP = 10;

interface Gesture {
  pointerId: number;
  key: string;
  row: HTMLElement;
  x: number;
  y: number;
  dx: number;
  mode: "pending" | "swipe" | "scroll";
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Swipe and long press on the list's rows, delegated from their container. Each row
 * carries `data-row-key`; the hook moves it with `--swipe-x` and marks it with
 * `data-swiping` (left|right) and `data-armed` once letting go would archive it.
 */
export function useRowGestures(options: {
  enabled: boolean;
  canSwipe: (key: string) => boolean;
  onSwipe: (key: string) => void;
  onLongPress: (key: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  // A swipe or a long press ends in a click on the row's button: that click is eaten.
  const swallowClick = useRef(false);

  const threshold = (row: HTMLElement) => Math.max(80, row.clientWidth * 0.3);
  const settle = (row: HTMLElement, to: number, after?: () => void) => {
    row.dataset.settling = "true";
    row.style.setProperty("--swipe-x", `${to}px`);
    setTimeout(() => {
      if (to === 0) {
        delete row.dataset.swiping;
        delete row.dataset.armed;
        row.style.removeProperty("--swipe-x");
      }
      delete row.dataset.settling;
      after?.();
    }, 180);
  };
  const stop = () => {
    const current = gesture.current;
    if (current?.timer) clearTimeout(current.timer);
    gesture.current = null;
  };

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!latest.current.enabled || event.pointerType !== "touch" || !event.isPrimary) return;
      const row = (event.target as Element).closest<HTMLElement>("[data-row-key]");
      const key = row?.dataset.rowKey;
      if (!row || !key || row.dataset.settling) return;
      stop();
      swallowClick.current = false;
      const started: Gesture = {
        pointerId: event.pointerId,
        key,
        row,
        x: event.clientX,
        y: event.clientY,
        dx: 0,
        mode: "pending",
        timer: null,
      };
      started.timer = setTimeout(() => {
        if (gesture.current !== started || started.mode !== "pending") return;
        started.timer = null;
        swallowClick.current = true;
        navigator.vibrate?.(12);
        latest.current.onLongPress(key);
        stop();
      }, LONG_PRESS_MS);
      gesture.current = started;
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (current.mode === "pending") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (current.timer) clearTimeout(current.timer);
        current.timer = null;
        if (Math.abs(dx) > Math.abs(dy) * 1.4 && latest.current.canSwipe(current.key)) {
          current.mode = "swipe";
          try {
            current.row.setPointerCapture(event.pointerId);
          } catch {}
        } else {
          current.mode = "scroll";
          stop();
          return;
        }
      }
      if (current.mode !== "swipe") return;
      current.dx = dx;
      current.row.dataset.swiping = dx < 0 ? "left" : "right";
      current.row.style.setProperty("--swipe-x", `${dx}px`);
      if (Math.abs(dx) >= threshold(current.row)) current.row.dataset.armed = "true";
      else delete current.row.dataset.armed;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      stop();
      if (current.mode !== "swipe") return;
      swallowClick.current = true;
      const { row, key, dx } = current;
      if (Math.abs(dx) >= threshold(row)) {
        settle(row, Math.sign(dx) * row.clientWidth, () => {
          latest.current.onSwipe(key);
          // The row leaves the list once archived; if it stays (refused), it slides back.
          setTimeout(() => {
            if (row.isConnected && row.dataset.swiping) settle(row, 0);
          }, 600);
        });
      } else settle(row, 0);
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      stop();
      if (current.mode === "swipe") settle(current.row, 0);
    },
    onClickCapture(event: { preventDefault(): void; stopPropagation(): void }) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event: { preventDefault(): void }) {
      // Android opens the page's context menu after a long press on a row.
      if (latest.current.enabled) event.preventDefault();
    },
  };
}

/** Pull distance (px, after resistance) that refreshes on release. */
const PULL_TRIGGER = 64;

/**
 * Pull to refresh on a scrolling list: dragging down from its very top shows the
 * indicator (`data-pull` on the list, `--pull` its distance) and letting go past the
 * trigger runs `onRefresh`, with `data-pull="refreshing"` until it settles.
 */
export function usePullToRefresh(
  list: RefObject<HTMLElement | null>,
  options: { enabled: boolean; onRefresh: () => Promise<unknown> },
) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const node = list.current;
    if (!node || !options.enabled) return;
    let start: { y: number; x: number } | null = null;
    let distance = 0;
    let busy = false;
    const show = (value: number) => {
      distance = value;
      node.style.setProperty("--pull", `${Math.round(value)}px`);
      if (value > 0) node.dataset.pull = value >= PULL_TRIGGER ? "armed" : "pulling";
      else delete node.dataset.pull;
    };
    const down = (event: TouchEvent) => {
      if (busy || event.touches.length !== 1 || node.scrollTop > 0) {
        start = null;
        return;
      }
      const touch = event.touches[0]!;
      start = { y: touch.clientY, x: touch.clientX };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0]!;
      const dy = touch.clientY - start.y;
      if (node.scrollTop > 0 || dy <= 0 || Math.abs(touch.clientX - start.x) > Math.abs(dy)) {
        if (distance) show(0);
        if (dy <= 0 || node.scrollTop > 0) start = null;
        return;
      }
      // Resistance: the indicator follows at half speed and stops at 96px.
      show(Math.min(96, dy * 0.5));
      if (event.cancelable) event.preventDefault();
    };
    const up = () => {
      if (!start) return;
      start = null;
      if (distance < PULL_TRIGGER) {
        show(0);
        return;
      }
      busy = true;
      node.dataset.pull = "refreshing";
      node.style.setProperty("--pull", `${PULL_TRIGGER}px`);
      void latest.current
        .onRefresh()
        .catch(() => {})
        .finally(() => {
          busy = false;
          show(0);
        });
    };
    node.addEventListener("touchstart", down, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", up);
    node.addEventListener("touchcancel", up);
    return () => {
      node.removeEventListener("touchstart", down);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", up);
      node.removeEventListener("touchcancel", up);
      delete node.dataset.pull;
      node.style.removeProperty("--pull");
    };
  }, [list, options.enabled]);
}
