"use client";

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useId, useImperativeHandle, useState } from "react";
import {
  type EditorNode,
  editorDocIsFormatted,
  editorDocToPlain,
  plainToEditorHtml,
} from "@/lib/mailbox-rich-text";
import styles from "./mailbox-rich-editor.module.css";

export type RichValue = { text: string; html: string; formatted: boolean };

export type RichEditorLabels = {
  toolbar: string;
  bold: string;
  italic: string;
  link: string;
  linkAddress: string;
  linkApply: string;
  linkRemove: string;
  bulletList: string;
  orderedList: string;
  quote: string;
};

export type RichEditorHandle = {
  /** Replaces the whole body with plain text (a new signature, a quick reply). */
  setText: (text: string) => void;
  focus: () => void;
};

/** What the server keeps of a link: web and mail addresses only. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

/**
 * The composer's body: bold, italic, links, lists and quotes, nothing the
 * server's HTML allowlist would drop. Every change reports the HTML and the
 * plain-text part that travels with it.
 */
export const MailboxRichEditor = forwardRef<
  RichEditorHandle,
  {
    initialText: string;
    initialHtml?: string | null | undefined;
    onChange: (value: RichValue) => void;
    disabled?: boolean;
    placeholder: string;
    ariaLabel: string;
    labels: RichEditorLabels;
    /** Where the cursor starts: the top (a reply), the end of the first line (after a quick reply). */
    autoFocus?: "start" | "firstLineEnd" | undefined;
  }
>(function MailboxRichEditor(
  {
    initialText,
    initialHtml,
    onChange,
    disabled = false,
    placeholder,
    ariaLabel,
    labels,
    autoFocus,
  },
  ref,
) {
  const linkId = useId();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const report = (doc: EditorNode, html: string) =>
    onChange({ text: editorDocToPlain(doc), html, formatted: editorDocIsFormatted(doc) });
  const editor = useEditor({
    // The Correio renders on the server first; the editor mounts in the browser.
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ["mailto"],
        HTMLAttributes: { rel: "noopener noreferrer", target: null },
        validate: (href) => SAFE_HREF.test(href),
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: initialHtml || plainToEditorHtml(initialText),
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        role: "textbox",
        spellcheck: "true",
        class: styles.body ?? "",
      },
    },
    onCreate: ({ editor: current }) => {
      // The composer's text becomes what the editor holds (a reply's quote,
      // a reopened formatted draft), so saving unchanged sends the same.
      report(current.getJSON() as EditorNode, current.getHTML());
      if (autoFocus === "firstLineEnd") current.chain().focus("start").selectTextblockEnd().run();
      else if (autoFocus === "start") current.commands.focus("start");
    },
    onUpdate: ({ editor: current }) => report(current.getJSON() as EditorNode, current.getHTML()),
  });

  useImperativeHandle(
    ref,
    () => ({
      setText: (text) => {
        if (!editor) return;
        editor.commands.setContent(plainToEditorHtml(text), true);
      },
      focus: () => editor?.commands.focus("start"),
    }),
    [editor],
  );

  const tool = (
    label: string,
    active: boolean,
    run: () => void,
    glyph: React.ReactNode,
    extra?: { "aria-expanded"?: boolean; "aria-controls"?: string },
  ) => (
    <button
      type="button"
      className={styles.tool}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled || !editor}
      // Keep the selection in the editor while the button is clicked.
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
      {...extra}
    >
      {glyph}
    </button>
  );

  const applyLink = () => {
    if (!editor) return;
    const raw = linkValue.trim();
    const href = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
      ? `mailto:${raw}`
      : /^[a-z][a-z0-9+.-]*:/i.test(raw)
        ? raw
        : raw
          ? `https://${raw}`
          : "";
    if (!href || !SAFE_HREF.test(href)) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkOpen(false);
  };

  return (
    <div className={styles.editor} data-disabled={disabled || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label={labels.toolbar}>
        {tool(
          labels.bold,
          !!editor?.isActive("bold"),
          () => editor?.chain().focus().toggleBold().run(),
          <b>B</b>,
        )}
        {tool(
          labels.italic,
          !!editor?.isActive("italic"),
          () => editor?.chain().focus().toggleItalic().run(),
          <i>I</i>,
        )}
        {tool(
          labels.link,
          !!editor?.isActive("link") || linkOpen,
          () => {
            setLinkValue((editor?.getAttributes("link").href as string | undefined) ?? "");
            setLinkOpen((open) => !open);
          },
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
          </svg>,
          { "aria-expanded": linkOpen, "aria-controls": linkId },
        )}
        <span className={styles.divider} aria-hidden="true" />
        {tool(
          labels.bulletList,
          !!editor?.isActive("bulletList"),
          () => editor?.chain().focus().toggleBulletList().run(),
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M9 6h11M9 12h11M9 18h11" />
            <circle cx="4.5" cy="6" r="1" fill="currentColor" />
            <circle cx="4.5" cy="12" r="1" fill="currentColor" />
            <circle cx="4.5" cy="18" r="1" fill="currentColor" />
          </svg>,
        )}
        {tool(
          labels.orderedList,
          !!editor?.isActive("orderedList"),
          () => editor?.chain().focus().toggleOrderedList().run(),
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M10 6h10M10 12h10M10 18h10" />
            <path d="M4 5h1.5v4M4 9h3M4 14.5c.5-.7 2.8-.8 2.8.6 0 1-2.8 1.6-2.8 3h3" />
          </svg>,
        )}
        {tool(
          labels.quote,
          !!editor?.isActive("blockquote"),
          () => editor?.chain().focus().toggleBlockquote().run(),
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 7h4v4c0 3-1.5 5-4 6l-.6-1.2C8 15 8.6 13.8 8.7 12H7V7Zm7 0h4v4c0 3-1.5 5-4 6l-.6-1.2c1.6-.8 2.2-2 2.3-3.8H14V7Z" />
          </svg>,
        )}
      </div>
      {linkOpen ? (
        <div className={styles.linkRow} id={linkId}>
          <label className={styles.linkLabel}>
            <span>{labels.linkAddress}</span>
            <input
              className="ms-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={linkValue}
              placeholder="https://"
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setLinkOpen(false);
                  editor?.commands.focus();
                }
              }}
            />
          </label>
          <button type="button" className="ms-btn ms-btn-sm" onClick={applyLink}>
            {labels.linkApply}
          </button>
          {editor?.isActive("link") ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost ms-btn-sm"
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setLinkOpen(false);
              }}
            >
              {labels.linkRemove}
            </button>
          ) : null}
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
});
