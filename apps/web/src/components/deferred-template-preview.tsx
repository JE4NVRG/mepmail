"use client";

import { useEffect, useRef, useState } from "react";
import { previewMergeTokens } from "@/lib/merge-fields";

/** Decorative previews do not put sample email content in the page's HTML. */
export function DeferredTemplatePreview({
  templateKey,
  locale,
  title,
}: {
  templateKey: string;
  locale: string;
  title: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { isStarterKey, renderStarter } = await import("@/server/starter-templates");
      if (!active || !isStarterKey(templateKey)) return;
      // The library is local static content. Scripts never belong in a decorative
      // email preview, including when future templates introduce one.
      const content = previewMergeTokens(renderStarter(templateKey, locale).html)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
        .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
      setHtml(content);
    };
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      { rootMargin: "100px 0px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [templateKey, locale]);

  return (
    <div className="cro-starter-preview" ref={container} aria-hidden="true" inert>
      {html ? <iframe title={title} srcDoc={html} sandbox="" tabIndex={-1} loading="lazy" /> : null}
    </div>
  );
}
