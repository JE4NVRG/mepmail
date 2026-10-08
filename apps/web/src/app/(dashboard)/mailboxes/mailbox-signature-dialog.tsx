"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  type MailboxSignatureProfile,
  mailboxSignatureHtml,
  mailboxSignatureText,
} from "@/lib/mailbox-signature";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-signature.module.css";
import shared from "./mailboxes.module.css";

const LOGO_MAX_WIDTH = 480;
const LOGO_MAX_HEIGHT = 200;

/** Logos leave the browser as PNG, scaled down to what an email signature needs. */
async function emailLogo(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_MAX_WIDTH / bitmap.width, LOGO_MAX_HEIGHT / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("encode");
  return blob;
}

function previewWebsite(value: string) {
  const site = value.trim();
  if (!site) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(site) ? site : `https://${site}`;
}

/**
 * The mailbox's email signature: name, title, company, phone, website, logo
 * and free lines, with a live preview of how recipients see it.
 */
export function MailboxSignatureDialog({
  mailbox,
  close,
}: {
  mailbox: {
    id: string;
    address: string;
    signatureText: string;
    signatureProfile: MailboxSignatureProfile | null;
  };
  close: () => void;
}) {
  const t = useTranslations("mailboxes.signature");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stored = mailbox.signatureProfile;
  const [name, setName] = useState(stored?.name ?? "");
  const [title, setTitle] = useState(stored?.title ?? "");
  const [company, setCompany] = useState(stored?.company ?? "");
  const [phone, setPhone] = useState(stored?.phone ?? "");
  const [website, setWebsite] = useState(stored?.website ?? "");
  const [text, setText] = useState(mailbox.signatureText);
  const [logo, setLogo] = useState({
    url: stored?.logoUrl ?? null,
    width: stored?.logoWidth ?? null,
    height: stored?.logoHeight ?? null,
  });
  const [logoBusy, setLogoBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const save = useMutation(trpc.mailboxes.updateSignature.mutationOptions({ retry: false }));
  const busy = save.isPending || logoBusy;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const draft = {
    profile: {
      version: 1 as const,
      name: name.trim(),
      title: title.trim(),
      company: company.trim(),
      phone: phone.trim(),
      website: previewWebsite(website),
      logoUrl: logo.url,
      logoWidth: logo.width,
      logoHeight: logo.height,
    },
    text,
  };
  const html = mailboxSignatureHtml(draft);
  const preview = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:"><style>html{color-scheme:light}body{margin:0;padding:18px;background:#fff;font:14px/1.55 Arial,sans-serif;color:#202124}p{margin:0 0 14px;color:#5f6368}</style></head><body><p>${t("previewGreeting")}</p>${html}</body></html>`;

  async function refresh() {
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
  }
  async function uploadLogo(file: File) {
    setNotice("");
    setLogoBusy(true);
    try {
      const body = new FormData();
      body.set("mailboxId", mailbox.id);
      body.set("file", await emailLogo(file), "logo.png");
      const response = await fetch("/api/mailbox-signature-logo", { method: "POST", body });
      if (!response.ok) {
        setNotice(
          t(
            response.status === 404
              ? "logoUnavailable"
              : response.status === 413
                ? "logoTooLarge"
                : response.status === 415
                  ? "logoInvalid"
                  : "logoError",
          ),
        );
        return;
      }
      const result = (await response.json()) as { signatureProfile: MailboxSignatureProfile };
      setLogo({
        url: result.signatureProfile.logoUrl,
        width: result.signatureProfile.logoWidth,
        height: result.signatureProfile.logoHeight,
      });
      await refresh();
    } catch {
      setNotice(t("logoInvalid"));
    } finally {
      setLogoBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function removeLogo() {
    setNotice("");
    setLogoBusy(true);
    try {
      const response = await fetch(
        `/api/mailbox-signature-logo?mailboxId=${encodeURIComponent(mailbox.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setNotice(t("logoError"));
        return;
      }
      setLogo({ url: null, width: null, height: null });
      await refresh();
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className={`${shared.dialog} ${styles.dialog}`}
      aria-labelledby="mailbox-signature-title"
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={shared.dialogHeader}>
        <h2 id="mailbox-signature-title">{t("title", { address: mailbox.address })}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={t("close")}
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <p className={shared.hint}>{t("lead")}</p>
      <form
        className={styles.layout}
        onSubmit={async (event) => {
          event.preventDefault();
          setNotice("");
          try {
            await save.mutateAsync({
              mailboxId: mailbox.id,
              name,
              title,
              company,
              phone,
              website,
              text,
            });
            await refresh();
            close();
          } catch (cause) {
            const code = (cause as { data?: { code?: string } })?.data?.code;
            setNotice(t(code === "BAD_REQUEST" ? "invalid" : "error"));
          }
        }}
      >
        <fieldset disabled={busy} className={styles.fields}>
          <label>
            {t("name")}
            <input
              className="ms-input"
              maxLength={80}
              value={name}
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("jobTitle")}
            <input
              className="ms-input"
              maxLength={80}
              value={title}
              autoComplete="organization-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            {t("company")}
            <input
              className="ms-input"
              maxLength={80}
              value={company}
              autoComplete="organization"
              onChange={(event) => setCompany(event.target.value)}
            />
          </label>
          <label>
            {t("phone")}
            <input
              className="ms-input"
              type="tel"
              maxLength={40}
              value={phone}
              autoComplete="tel"
              placeholder="+55 11 99999-0000"
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <label className={styles.wide}>
            {t("website")}
            <input
              className="ms-input"
              maxLength={200}
              value={website}
              inputMode="url"
              placeholder="suaempresa.com.br"
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>
          <div className={`${styles.wide} ${styles.logoRow}`}>
            <span className={styles.logoLabel}>{t("logo")}</span>
            {logo.url ? (
              // biome-ignore lint/performance/noImgElement: a user-uploaded logo on our public storage, shown as-is
              <img className={styles.logoThumb} src={logo.url} alt="" />
            ) : null}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadLogo(file);
              }}
            />
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => fileInput.current?.click()}
            >
              {t(logo.url ? "logoReplace" : "logoUpload")}
            </button>
            {logo.url ? (
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                onClick={() => void removeLogo()}
              >
                {t("logoRemove")}
              </button>
            ) : null}
            <small>{t("logoHint")}</small>
          </div>
          <label className={styles.wide}>
            {t("extra")}
            <textarea
              className="ms-input"
              maxLength={4000}
              rows={3}
              value={text}
              placeholder={t("extraPlaceholder")}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        </fieldset>
        <section className={styles.preview} aria-label={t("preview")}>
          <h3>{t("preview")}</h3>
          <iframe
            title={t("preview")}
            className={styles.previewFrame}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={preview}
          />
          <details className={styles.textVersion}>
            <summary>{t("textVersion")}</summary>
            <pre>{`--\n${mailboxSignatureText(draft) || t("emptyText")}`}</pre>
          </details>
        </section>
        {notice ? (
          <p role="alert" className={`${shared.error} ${styles.wide}`}>
            {notice}
          </p>
        ) : null}
        <footer className={`${shared.dialogFooter} ${styles.footer}`}>
          <button type="button" className="ms-btn" disabled={busy} onClick={close}>
            {t("cancel")}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={busy}>
            {t(save.isPending ? "saving" : "save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
