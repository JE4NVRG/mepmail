"use client";

import { useLocale, useTranslations } from "next-intl";
import {
  type CSSProperties,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type MailboxTimeKind,
  mailboxTimeAllowed,
  mailboxTimeLabel,
  mailboxTimePresets,
  parseLocalDateTime,
  toLocalDateTime,
} from "@/lib/mailbox-time";
import styles from "./mailbox-move-menu.module.css";

export type MailboxTimeMenuHandle = { open: () => void };

const GAP = 6;

/**
 * "Snooze", "Send later" and "Remind me": a few named moments in local time,
 * "pick a date and time", and, when a time is set, the way to clear it.
 * Arrow keys pick, Enter confirms, Escape closes. A phone gets a bottom sheet.
 */
export const MailboxTimeMenu = forwardRef<
  MailboxTimeMenuHandle,
  {
    kind: MailboxTimeKind;
    /** The time set now, if any: the menu then offers to clear it. */
    current: Date | null;
    label: string;
    icon: ReactNode;
    clearLabel: string;
    variant?: "icon" | "button";
    disabled?: boolean;
    onPick: (at: Date | null) => void;
  }
>(function MailboxTimeMenu(
  { kind, current, label, icon, clearLabel, variant = "icon", disabled = false, onPick },
  ref,
) {
  const t = useTranslations("mailboxes.timing");
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState<string | null>(null);
  const [place, setPlace] = useState<{ style?: CSSProperties; sheet: boolean }>({ sheet: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  function show() {
    if (disabled) return;
    const rect = trigger.current?.getBoundingClientRect();
    const sheet = window.matchMedia("(max-width: 620px)").matches;
    if (!rect || sheet) setPlace({ sheet: true });
    else {
      const viewportW = document.documentElement.clientWidth;
      const viewportH = document.documentElement.clientHeight;
      const up = rect.bottom + GAP + 320 > viewportH && rect.top > viewportH - rect.bottom;
      setPlace({
        sheet: false,
        style: {
          position: "fixed",
          ...(up ? { bottom: viewportH - rect.top + GAP } : { top: rect.bottom + GAP }),
          right: Math.max(12, viewportW - rect.right),
        },
      });
    }
    setNow(new Date());
    setActive(0);
    setCustom(null);
    setOpen(true);
  }
  useImperativeHandle(ref, () => ({ open: show }));
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-option]")?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    }
    function onReflow(event: Event) {
      if (panel.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);
  useEffect(() => {
    if (custom !== null) picker.current?.focus({ preventScroll: true });
  }, [custom]);

  const presets = mailboxTimePresets(kind, now);
  type Option = { key: string; text: string; hint?: string; run: () => void };
  const options: Option[] = [
    ...presets.map((preset) => ({
      key: preset.key,
      text: t(`presets.${preset.key}`),
      hint: mailboxTimeLabel(preset.at, now, locale),
      run: () => {
        close();
        onPick(preset.at);
      },
    })),
    {
      key: "pick",
      text: t("pickTime"),
      run: () => {
        const start = current && mailboxTimeAllowed(current, now) ? current : presets[0]?.at;
        setCustom(toLocalDateTime(start ?? new Date(now.getTime() + 3_600_000)));
      },
    },
    ...(current
      ? [
          {
            key: "clear",
            text: clearLabel,
            run: () => {
              close();
              onPick(null);
            },
          },
        ]
      : []),
  ];
  const picked = custom === null ? null : parseLocalDateTime(custom);
  const pickedValid = !!picked && mailboxTimeAllowed(picked, new Date());

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (custom !== null) setCustom(null);
      else close();
      return;
    }
    if (event.key === "Tab" && custom === null) {
      close(false);
      return;
    }
    if (custom !== null) {
      if (event.key === "Enter" && pickedValid && picked) {
        event.preventDefault();
        close();
        onPick(picked);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActive(next);
      panel.current?.querySelectorAll<HTMLElement>("[data-option]")[next]?.focus();
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={
          variant === "icon"
            ? `ms-btn ms-btn-ghost ${styles.iconTrigger}`
            : `ms-btn ms-btn-ghost ms-btn-sm ${styles.buttonTrigger}`
        }
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        {icon}
        {variant === "button" ? <span>{label}</span> : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              role="menu"
              aria-label={label}
              className={place.sheet ? styles.panel : `ms-menu ${styles.panel}`}
              data-sheet={place.sheet || undefined}
              style={place.style}
              onKeyDown={onKeyDown}
            >
              <p className={`ms-menu-label ${styles.state}`} id={`${id}-title`}>
                {label}
              </p>
              {custom === null ? (
                <div className={styles.list}>
                  {options.map((option, index) => (
                    <button
                      key={option.key}
                      type="button"
                      role="menuitem"
                      data-option
                      data-kind={option.key === "clear" ? "remove" : undefined}
                      data-active={index === active || undefined}
                      tabIndex={index === active ? 0 : -1}
                      className={`ms-menu-item ${styles.option}`}
                      onMouseEnter={() => setActive(index)}
                      onFocus={() => setActive(index)}
                      onClick={option.run}
                    >
                      <span className={styles.name}>{option.text}</span>
                      {option.hint ? <span className={styles.check}>{option.hint}</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <form
                  className={styles.pickForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!pickedValid || !picked) return;
                    close();
                    onPick(picked);
                  }}
                >
                  <input
                    ref={picker}
                    type="datetime-local"
                    className={`ms-input ${styles.search}`}
                    value={custom}
                    min={toLocalDateTime(new Date(Date.now() + 60_000))}
                    aria-label={t("pickTime")}
                    onChange={(event) => setCustom(event.target.value)}
                  />
                  {custom && !pickedValid ? (
                    <p className={styles.state} role="status">
                      {t("invalidTime")}
                    </p>
                  ) : null}
                  <div className={styles.pickActions}>
                    <button
                      type="button"
                      className="ms-btn ms-btn-ghost ms-btn-sm"
                      onClick={() => setCustom(null)}
                    >
                      {t("back")}
                    </button>
                    <button
                      type="submit"
                      className="ms-btn ms-btn-primary ms-btn-sm"
                      disabled={!pickedValid}
                    >
                      {t("confirm")}
                    </button>
                  </div>
                </form>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
});
