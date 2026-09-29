"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { trackEvent } from "@/lib/analytics";
import { arrivalEvent } from "@/lib/public-funnel";
import { CopyMark, useCopy } from "./copy-chip";

/**
 * The public site's campaign events (launch-ops.md §3.2).
 *
 * Every component here is a thin client wrapper around an existing link or
 * affordance: the marketing pages are server components and must stay that way,
 * so the click that only the browser can see is measured in the smallest client
 * leaf that owns it. All of them go through lib/analytics trackEvent, which is
 * best-effort — a blocked tracker, an offline visitor or a missing script never
 * holds up the navigation.
 */

/** The docs link (nav + footer): leaving for the docs site is a funnel step of its own. */
export function DocsLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => trackEvent("docs_open", { from_page: pathname })}
    >
      {children}
    </a>
  );
}

/** A click out to GitHub: the footer's mark and credit, the only repo links the public site has. */
export function GithubLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => trackEvent("github_out", { page: pathname })}
    >
      {children}
    </a>
  );
}

/**
 * The arrival event of the landing visit, fired once on mount.
 *
 * A campaign link carries the channel in its own query string, which is gone by
 * the time anyone looks at a report — Umami would see only a pageview. This
 * turns the link into the named event (`hn_arrival`, `ph_arrival`,
 * `reddit_arrival`) with the utm_content that says which post it was. Silent
 * for every visit that names no channel.
 */
export function ArrivalTracker() {
  useEffect(() => {
    const event = arrivalEvent(window.location.search);
    if (event) trackEvent(event.name, event.props);
  }, []);
  return null;
}

/**
 * Copy button on the landing's MCP config block. The block is the local (stdio)
 * `npx -y @mepmail/mcp` setup, so the copy it records is `mcp_copy` with
 * `mode: stdio`; the dashboard's own snippets report `mode: http`.
 */
export function McpConfigCopy({ value }: { value: string }) {
  const { copied, copy, label } = useCopy(value);
  return (
    <button
      type="button"
      className="gtm-copy"
      aria-label={label}
      onClick={() => {
        void copy();
        trackEvent("mcp_copy", { mode: "stdio" });
      }}
    >
      <CopyMark copied={copied} size={12} />
      {label}
    </button>
  );
}
