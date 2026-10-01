"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { TEAM_LOGO_ACCEPT } from "@/lib/image-type";
import { prepareProfilePhoto, removeProfilePhoto, uploadProfilePhoto } from "@/lib/profile-photo";
import { BtnSpinner } from "./spinner";
import { UserAvatar } from "./user-avatar";

export function ProfileSettings({ uploads }: { uploads: boolean }) {
  const t = useTranslations("settings.profile");
  const { data: session, refetch } = authClient.useSession();
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "error" | "invalid" | null>(null);
  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  async function choose(file: File) {
    setMessage(null);
    setBusy(true);
    try {
      setPhoto(await prepareProfilePhoto(file));
    } catch {
      setPhoto(null);
      setMessage("invalid");
    } finally {
      setBusy(false);
    }
  }
  async function change(remove = false) {
    setBusy(true);
    setMessage(null);
    try {
      if (remove) await removeProfilePhoto();
      else if (photo) await uploadProfilePhoto(photo);
      setPhoto(null);
      await refetch();
      router.refresh();
      setMessage("saved");
    } catch {
      setMessage("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      id="profile"
      className="ms-card"
      style={{ padding: 24, marginBottom: 24, scrollMarginTop: 32 }}
    >
      <h2 style={{ fontSize: 18, margin: "0 0 16px" }}>{t("title")}</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        {preview ? (
          // biome-ignore lint/performance/noImgElement: Local blob preview cannot use Next image optimization.
          <img
            src={preview}
            alt={t("preview")}
            width={64}
            height={64}
            style={{ borderRadius: "50%", objectFit: "cover" }}
          />
        ) : (
          <UserAvatar size={64} />
        )}
        <div style={{ display: "grid", gap: 8, flex: 1, minWidth: 200 }}>
          <strong>{session?.user.name}</strong>
          <span style={{ color: "var(--ms-muted)", fontSize: 13 }}>{session?.user.email}</span>
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: 13 }}>{t("hint")}</p>
          <input
            ref={picker}
            type="file"
            accept={TEAM_LOGO_ACCEPT}
            aria-label={t("choose")}
            hidden
            disabled={!uploads || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void choose(file);
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={!uploads || busy || !session}
              onClick={() => picker.current?.click()}
            >
              {t("choose")}
            </button>
            {photo ? (
              <>
                <button
                  type="button"
                  className="ms-btn ms-btn-primary"
                  disabled={busy}
                  onClick={() => void change()}
                >
                  <BtnSpinner on={busy} />
                  {t("save")}
                </button>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={busy}
                  onClick={() => setPhoto(null)}
                >
                  {t("cancel")}
                </button>
              </>
            ) : session?.user.image ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={busy}
                onClick={() => void change(true)}
              >
                {t("remove")}
              </button>
            ) : null}
          </div>
          {!uploads && (
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: 12 }}>{t("unavailable")}</p>
          )}
          {message && (
            <p
              role="status"
              style={{
                margin: 0,
                fontSize: 13,
                color: message === "saved" ? "var(--ms-success)" : "var(--ms-danger)",
              }}
            >
              {t(message)}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
