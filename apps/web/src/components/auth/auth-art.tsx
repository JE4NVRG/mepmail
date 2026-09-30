"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import styles from "./auth.module.css";

const POSTER = "/product/auth-personalization.webp";
const VIDEO = "/product/auth-personalization.mp4";
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export function AuthArt() {
  const t = useTranslations("auth.shell");
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [desktop, setDesktop] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [manualPause, setManualPause] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = desktop && !reduced && !failed;
  const canPlay = enabled && visible && inView;

  useEffect(() => {
    const viewport = window.matchMedia("(min-width: 960px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setDesktop(viewport.matches);
      setReduced(motion.matches);
      setVisible(document.visibilityState === "visible");
    };
    update();
    viewport.addEventListener("change", update);
    motion.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false));
    if (frameRef.current) observer?.observe(frameRef.current);
    return () => {
      viewport.removeEventListener("change", update);
      motion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    if (canPlay && !manualPause) {
      video.play().catch(() => {
        if (!cancelled) {
          setPlaying(false);
          setManualPause(true);
        }
      });
    } else {
      video.pause();
    }
    return () => {
      cancelled = true;
      video.pause();
    };
  }, [canPlay, manualPause]);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      setManualPause(true);
      video.pause();
    } else if (canPlay) {
      setManualPause(false);
      // Chamada no gesto do usuário também atende navegadores que negam autoplay.
      video.play().catch(() => {
        setPlaying(false);
        setManualPause(true);
      });
    }
  }

  return (
    <figure className={styles.art}>
      <div className={styles.artFrame} ref={frameRef}>
        <picture>
          <source media="(min-width: 960px)" srcSet={POSTER} type="image/webp" />
          {/* picture nativo evita download do poster no mobile e funciona sem JS. */}
          <img src={EMPTY_IMAGE} width={960} height={960} alt={t("artAlt")} />
        </picture>
        {enabled && (
          <video
            ref={videoRef}
            src={VIDEO}
            poster={POSTER}
            width={960}
            height={960}
            muted
            playsInline
            loop
            preload="none"
            aria-hidden="true"
            tabIndex={-1}
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <figcaption className={styles.artFooter}>
        <span>{t("artCaption")}</span>
        {enabled && (
          <button type="button" className={styles.artControl} onClick={togglePlayback}>
            <span aria-hidden="true">{playing ? "Ⅱ" : "▷"}</span>
            {t(playing ? "pauseAnimation" : "playAnimation")}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
