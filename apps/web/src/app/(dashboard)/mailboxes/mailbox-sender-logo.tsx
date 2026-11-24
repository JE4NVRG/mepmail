"use client";

import { useEffect, useState } from "react";
import { senderPictureUrl } from "@/lib/mailbox-sender-logo";
import styles from "./mailbox-sender-logo.module.css";

/** Pictures that did not load this session: their initials stay, with no second request. */
const missing = new Set<string>();

/**
 * A sender's picture over its initials (the avatar it sits in keeps the letters as the
 * fallback): the brand's logo, the person's Gravatar, or the website icon, as our server
 * finds them. `token` is signed by the server for received mail that passed DMARC
 * (rows' senderPicture); without one nothing is asked.
 */
export function MailboxSenderLogo({ token }: { token: string | null | undefined }) {
  const url = token ? senderPictureUrl(token) : null;
  const [failed, setFailed] = useState(() => !url || missing.has(url));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(!url || missing.has(url));
    setLoaded(false);
  }, [url]);
  if (!url || failed) return null;
  return (
    // biome-ignore lint/performance/noImgElement: a same-origin proxy answering 404 for "no picture"; next/image would log every miss instead of falling back to the initials.
    <img
      className={styles.logo}
      data-loaded={loaded || undefined}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth <= 1 && img.naturalHeight <= 1) {
          missing.add(url);
          setFailed(true);
          return;
        }
        setLoaded(true);
      }}
      onError={() => {
        missing.add(url);
        setFailed(true);
      }}
    />
  );
}
