"use client";

import { type ReactNode, type RefObject, useId, useMemo, useRef, useState } from "react";
import {
  isRecipientAddress,
  type MailboxContact,
  matchContacts,
  mergeRecipients,
  splitRecipients,
} from "@/lib/mailbox-recipients";
import styles from "./mailboxes.module.css";

/**
 * A recipient list typed like in mail apps: a comma, semicolon, Enter, Tab or
 * leaving the field turns what was typed into a chip (red when it is not a
 * valid address), Backspace on an empty field takes the last chip back to
 * edit, and known contacts are suggested while typing.
 */
export function MailboxRecipientField({
  label,
  values,
  onChange,
  contacts,
  placeholder,
  inputRef,
  autoFocus,
  action,
  text,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  contacts: MailboxContact[];
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /** Shown at the end of the label row (the To field's "+ Cc"). */
  action?: ReactNode;
  text: { remove: (address: string) => string; invalid: string; suggestions: string };
}) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  // Escape closes the suggestions until the next keystroke.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const names = useMemo(
    () => new Map(contacts.map((contact) => [contact.address.toLowerCase(), contact.name])),
    [contacts],
  );
  const matches = useMemo(() => matchContacts(contacts, draft, values), [contacts, draft, values]);
  const open = focused && !dismissed && matches.length > 0;
  const current = Math.min(active, Math.max(matches.length - 1, 0));

  function commit(typed: string, keep = "") {
    const added = splitRecipients(typed);
    if (added.length) onChange(mergeRecipients(values, added));
    setDraft(keep);
    setActive(0);
  }
  function pick(contact: MailboxContact) {
    onChange(mergeRecipients(values, [contact.address]));
    setDraft("");
    setActive(0);
    input.current?.focus();
  }
  function edit(address: string) {
    onChange(values.filter((value) => value !== address));
    setDraft(address);
    input.current?.focus();
  }

  return (
    <div className={styles.recipientField}>
      <div className={styles.recipientLabelRow}>
        <label htmlFor={`${id}-input`}>{label}</label>
        {action}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's empty space focuses its input, as a text field would */}
      <div
        className={`ms-input ${styles.recipientBox}`}
        data-focused={focused ? "true" : undefined}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          input.current?.focus();
        }}
      >
        {values.map((address) => {
          const valid = isRecipientAddress(address);
          const name = names.get(address.toLowerCase());
          return (
            <span
              key={address}
              className={styles.recipientChip}
              data-invalid={valid ? undefined : "true"}
              title={valid ? address : `${text.invalid}: ${address}`}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click to edit is a shortcut; Backspace does the same from the keyboard */}
              <span className={styles.recipientChipText} onDoubleClick={() => edit(address)}>
                {name || address}
              </span>
              <button
                type="button"
                className={styles.recipientChipRemove}
                aria-label={text.remove(address)}
                onClick={() => {
                  onChange(values.filter((value) => value !== address));
                  input.current?.focus();
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          id={`${id}-input`}
          className={styles.recipientInput}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${id}-option-${current}` : undefined}
          value={draft}
          placeholder={values.length ? "" : placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          maxLength={1000}
          // biome-ignore lint/a11y/noAutofocus: the composer opens on the field the person types first
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (draft.trim()) commit(draft);
          }}
          onChange={(e) => {
            const value = e.target.value;
            setDismissed(false);
            // A comma, semicolon or a pasted list closes every finished address.
            const cut = Math.max(
              value.lastIndexOf(","),
              value.lastIndexOf(";"),
              value.lastIndexOf("\n"),
            );
            if (cut !== -1) commit(value.slice(0, cut), value.slice(cut + 1).trimStart());
            else {
              setDraft(value);
              setActive(0);
            }
          }}
          onKeyDown={(e) => {
            if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + matches.length) % matches.length);
              return;
            }
            if (open && e.key === "Escape") {
              // Close the suggestions, not the composer.
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            if (e.key === "Enter") {
              // Enter never submits the message from here.
              e.preventDefault();
              const match = matches[current];
              if (open && match) pick(match);
              else if (draft.trim()) commit(draft);
              return;
            }
            if (e.key === "Tab" && !e.shiftKey && draft.trim()) {
              const match = matches[current];
              if (open && match) {
                e.preventDefault();
                pick(match);
              } else commit(draft);
              return;
            }
            if (e.key === " " && isRecipientAddress(draft.trim())) {
              e.preventDefault();
              commit(draft);
              return;
            }
            if (e.key === "Backspace" && !draft && values.length) {
              e.preventDefault();
              const last = values[values.length - 1] ?? "";
              onChange(values.slice(0, -1));
              setDraft(last);
            }
          }}
        />
      </div>
      {open ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={text.suggestions}
          className={styles.recipientSuggestions}
          // Keep focus in the input so choosing does not first close the list.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((contact, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: options are chosen from the keyboard in the combobox input (arrows, Enter, Tab)
            <div
              key={contact.address}
              id={`${id}-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === current}
              className={styles.recipientOption}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(contact)}
            >
              <strong>{contact.name || contact.address}</strong>
              {contact.name ? <span>{contact.address}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
