"use client";

import { useEffect, useRef, useState } from "react";
import {
  applyColumnWidths,
  COLUMN_STEP,
  COLUMN_STEP_LARGE,
  type ColumnName,
  type ColumnWidths,
  clampColumn,
  columnBounds,
  readColumnWidths,
  saveColumnWidths,
} from "@/lib/mailbox-columns";
import styles from "./mailboxes.module.css";

type Drag = {
  pointer: number;
  startX: number;
  startWidth: number;
  space: number;
  before: ColumnWidths;
  width: number;
};

/**
 * A draggable edge between two Correio columns (window splitter): pointer
 * drag with capture, so the message iframe never swallows the move; arrows,
 * Shift+arrows, Home and End from the keyboard; double click restores the
 * default. The column is measured, never guessed, and the width is saved on
 * this device when the drag ends. Escape, pointercancel or leaving the window
 * puts back the width from before the drag. The CSS decides when the divider
 * shows (never beside a hidden or icons-only column).
 */
export function MailboxColumnDivider({
  column,
  controls,
  label,
  className,
}: {
  column: ColumnName;
  /** The id of the column this divider resizes. */
  controls: string;
  label: string;
  className?: string | undefined;
}) {
  const node = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [bounds, setBounds] = useState<{ min: number; max: number } | null>(null);
  const [active, setActive] = useState(false);

  const target = () => document.getElementById(controls);
  // The space the column shares: its grid container (the workspace for the
  // rail, the panels for the list).
  const space = () => node.current?.parentElement?.getBoundingClientRect().width ?? 0;

  // Pages without the prepaint script (src/app/(mail)/layout.tsx) still get
  // the widths saved on this device.
  useEffect(() => applyColumnWidths(readColumnWidths()), []);

  // Keep aria-valuenow honest while the window or the other column changes.
  useEffect(() => {
    const element = document.getElementById(controls);
    const parent = node.current?.parentElement;
    if (!element || !parent || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setWidth(Math.round(element.getBoundingClientRect().width));
      setBounds(columnBounds(column, parent.getBoundingClientRect().width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [column, controls]);

  function finish(keep: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setActive(false);
    delete document.documentElement.dataset.colResizing;
    const handle = node.current;
    if (handle?.hasPointerCapture(current.pointer)) handle.releasePointerCapture(current.pointer);
    if (keep && current.width !== current.startWidth)
      saveColumnWidths({ ...current.before, [column]: current.width });
    else applyColumnWidths(current.before);
  }

  // Leaving the window mid-drag (Alt+Tab, a dialog) cancels it.
  useEffect(() => {
    if (!active) return;
    const cancel = () => finish(false);
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  });
  // Unmounting mid-drag never leaves the page in resize mode.
  useEffect(
    () => () => {
      if (drag.current) delete document.documentElement.dataset.colResizing;
    },
    [],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter; <hr> cannot take focus or a value.
    <div
      ref={node}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width ?? undefined}
      aria-valuemin={bounds?.min}
      aria-valuemax={bounds?.max}
      aria-valuetext={width === null ? undefined : `${width} px`}
      tabIndex={0}
      className={`${styles.columnDivider} ${className ?? ""}`}
      data-active={active || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const element = target();
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        const startWidth = Math.round(element.getBoundingClientRect().width);
        drag.current = {
          pointer: event.pointerId,
          startX: event.clientX,
          startWidth,
          space: space(),
          before: readColumnWidths(),
          width: startWidth,
        };
        document.documentElement.dataset.colResizing = column;
        setActive(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointer) return;
        const next = clampColumn(
          column,
          current.startWidth + event.clientX - current.startX,
          current.space,
        );
        if (next === current.width) return;
        current.width = next;
        applyColumnWidths({ ...current.before, [column]: next });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        const { [column]: _dropped, ...rest } = readColumnWidths();
        saveColumnWidths(rest);
      }}
      onKeyDown={(event) => {
        if (drag.current) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
          return;
        }
        const element = target();
        if (!element) return;
        const now = element.getBoundingClientRect().width;
        const step = event.shiftKey ? COLUMN_STEP_LARGE : COLUMN_STEP;
        const room = space();
        const limits = columnBounds(column, room);
        const next =
          event.key === "ArrowLeft"
            ? now - step
            : event.key === "ArrowRight"
              ? now + step
              : event.key === "Home"
                ? limits.min
                : event.key === "End"
                  ? limits.max
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        saveColumnWidths({ ...readColumnWidths(), [column]: clampColumn(column, next, room) });
      }}
    />
  );
}
