"use client";

import { useEffect } from "react";

/** Só anima grupos que já entraram na tela; a base SSR nunca fica escondida. */
export function LandingMotion() {
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (typeof IntersectionObserver === "undefined" || !Element.prototype.animate) return;
    const animations = new Set<Animation>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          if (preference.matches) continue;
          const animation = entry.target.animate(
            [
              { opacity: 0.35, transform: "translateY(12px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 650, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          );
          animations.add(animation);
          animation.onfinish = () => animations.delete(animation);
        }
      },
      { threshold: 0.08 },
    );
    document
      .querySelectorAll(".cro .gtm-section:not(.gtm-hero) > .gtm-container")
      .forEach((node) => {
        observer.observe(node);
      });
    const cancelMotion = () => {
      if (preference.matches) {
        for (const animation of animations) animation.cancel();
        animations.clear();
      }
    };
    preference.addEventListener("change", cancelMotion);
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", cancelMotion);
      for (const animation of animations) animation.cancel();
    };
  }, []);
  return null;
}
