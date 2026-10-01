"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { EllipsisGlyph, NavGlyph, type NavIconName } from "@/components/icons/nav-icons";
import { useDismiss } from "@/components/popover-menu";
import { TeamSwitcher } from "@/components/team-switcher";
import { UserAvatar } from "@/components/user-avatar";
import { authClient } from "@/lib/auth-client";
import { DOCS_URL } from "@/lib/docs-links";
import { isAppLocale, LOCALES, setLocaleCookie } from "@/lib/locale-cookie";
import { isActive, navItemsWithConsole } from "@/lib/nav";
import { applyTheme, currentTheme, type Theme } from "@/lib/theme";
import { useTRPC } from "@/lib/trpc";

// Canvas nav order (Row 1 chrome): Settings lives in the main list.
export const NAV_ITEMS: ReadonlyArray<{ key: string; href: string; icon: NavIconName }> = [
  { key: "emails", href: "/emails", icon: "emails" },
  { key: "broadcasts", href: "/broadcasts", icon: "broadcasts" },
  { key: "templates", href: "/templates", icon: "templates" },
  { key: "audience", href: "/audience", icon: "audience" },
  { key: "metrics", href: "/metrics", icon: "metrics" },
  { key: "domains", href: "/domains", icon: "domains" },
  { key: "logs", href: "/logs", icon: "logs" },
  { key: "apiKeys", href: "/api-keys", icon: "api-keys" },
  { key: "webhooks", href: "/webhooks", icon: "webhooks" },
  { key: "settings", href: "/settings", icon: "settings" },
];

/**
 * The operator console's row: rendered only for the instance operator (see
 * navItemsWithConsole). Non-operators keep the plain list — and the console
 * itself is a 404 for them, since the gate is the server's, not this item.
 */
export const CONSOLE_NAV_ITEM: (typeof NAV_ITEMS)[number] = {
  key: "console",
  href: "/console",
  icon: "console",
};

// Hover state lives per link so a hover repaints one glyph, not the whole nav.
function NavItem({
  item,
  active,
  label,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  label: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link
      href={item.href}
      className={active ? "active" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <NavGlyph name={item.icon} hovered={hovered} />
      {label}
    </Link>
  );
}

/* Language row — the same segmented pill with the two language codes; the
   cookie is the whole setting, so the server re-renders the tree on refresh. */
export function LanguageRow() {
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  return (
    <div className="ms-menu-item static">
      {tCommon("accountMenu.language")}
      <span className="ms-theme-toggle">
        {LOCALES.map((value) => (
          <button
            key={value}
            type="button"
            className={locale === value ? "active wide" : "wide"}
            aria-label={tCommon(`accountMenu.language_${value === "en" ? "en" : "ptBR"}`)}
            aria-pressed={locale === value}
            onClick={() => {
              if (locale === value || !isAppLocale(value)) return;
              setLocaleCookie(value);
              router.refresh();
            }}
          >
            {value === "en" ? "EN" : "PT"}
          </button>
        ))}
      </span>
    </div>
  );
}

/* Appearance row — label + segmented sun/moon toggle, per the account-menu
   grammar. Mounts only inside the open menu, so document is available and the
   initial state can read the live attribute. */
export function AppearanceRow() {
  const tCommon = useTranslations("common");
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const pick = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  return (
    <div className="ms-menu-item static">
      {tCommon("accountMenu.appearance")}
      <span className="ms-theme-toggle">
        <button
          type="button"
          className={theme === "light" ? "active" : undefined}
          aria-label={tCommon("accountMenu.themeLight")}
          aria-pressed={theme === "light"}
          onClick={() => pick("light")}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4.4" />
            <path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
          </svg>
        </button>
        <button
          type="button"
          className={theme === "dark" ? "active" : undefined}
          aria-label={tCommon("accountMenu.themeDark")}
          aria-pressed={theme === "dark"}
          onClick={() => pick("dark")}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
          </svg>
        </button>
      </span>
    </div>
  );
}

export function Sidebar({
  teamName,
  teamLogoUrl,
  userEmail,
  className,
  onNavigate,
}: {
  teamName: string;
  teamLogoUrl?: string | null | undefined;
  userEmail: string;
  /** Hook for the responsive drawer treatment (see components.css .ms-sidebar). */
  className?: string;
  /** Fired when a nav link is chosen, so the mobile drawer can close. */
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
  const trpc = useTRPC();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useDismiss(accountRef, menuOpen, () => setMenuOpen(false));
  // The console is the operator's own: the item appears only for them, and
  // the gate is the server's (a 404 for anyone else), never this query.
  const operator = useQuery(trpc.system.operator.queryOptions());
  // The console's row rides on the same query the account menu uses: an
  // operator sees /console in the nav, everyone else keeps the plain list.
  const navItems = navItemsWithConsole(
    NAV_ITEMS,
    CONSOLE_NAV_ITEM,
    operator.data?.isOperator === true,
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      className={className}
      style={{
        width: 240,
        flexShrink: 0,
        background: "var(--ms-panel)",
        borderRight: "1px solid var(--ms-line)",
        position: "sticky",
        // Set only while a support view's strip is on screen; unset is 0.
        top: "var(--ms-support-strip-h, 0px)",
        height: "calc(100vh - var(--ms-support-strip-h, 0px))",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px 12px",
      }}
    >
      <div style={{ padding: "4px 10px 14px" }}>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img
          src="/logo/mepmail-wordmark.svg"
          className="ms-wordmark"
          alt={tCommon("appName")}
          style={{ height: 15, display: "block" }}
        />
      </div>
      <TeamSwitcher teamName={teamName} teamLogoUrl={teamLogoUrl} />
      {/* The list scrolls, and a scroll container clips its children's
          focus ring at its own edges. Side padding pulled back by the same
          margin keeps the ring inside the scrollable box without moving the
          items. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated close-drawer hook; links stay the interactive elements and keyboard activation bubbles the same click */}
      <nav
        className="ms-nav"
        style={{ minHeight: 0, overflowY: "auto", padding: 3, margin: "7px -3px -3px" }}
        onClick={
          onNavigate
            ? (event) => {
                if ((event.target as HTMLElement).closest("a")) onNavigate();
              }
            : undefined
        }
      >
        {navItems.map((item) => (
          <NavItem
            key={item.key}
            item={item}
            active={isActive(pathname, item.href)}
            label={t(item.key)}
          />
        ))}
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flex: "none", display: "block" }}
          >
            <path d="M12 7v14M3 3h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6v16h-6a3 3 0 0 0-3 2 3 3 0 0 0-3-2H3Z" />
          </svg>
          {t("docs")}
        </a>
        <a href="/source" title={t("sourceDownload")}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flex: "none", display: "block" }}
          >
            <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
          </svg>
          {t("sourceCode")}
        </a>
      </nav>
      <div style={{ flex: 1 }} />
      <div ref={accountRef} style={{ position: "relative", borderTop: "1px solid var(--ms-line)" }}>
        {menuOpen ? (
          <div
            role="menu"
            className="ms-menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 4,
              right: 4,
              minWidth: 0,
              zIndex: 6,
            }}
          >
            <Link
              href="/settings"
              role="menuitem"
              className="ms-menu-item"
              onClick={() => setMenuOpen(false)}
            >
              {t("settings")}
            </Link>
            {operator.data?.isOperator ? (
              <Link
                href="/console"
                role="menuitem"
                className="ms-menu-item"
                onClick={() => setMenuOpen(false)}
              >
                {t("console")}
              </Link>
            ) : null}
            <Link
              href="/onboarding"
              role="menuitem"
              className="ms-menu-item"
              onClick={() => setMenuOpen(false)}
            >
              {tCommon("accountMenu.onboarding")}
            </Link>
            <AppearanceRow />
            <LanguageRow />
            <hr className="ms-menu-sep" />
            <button type="button" role="menuitem" className="ms-menu-item" onClick={signOut}>
              {tCommon("signOut")}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            width: "100%",
            padding: "8px 10px 2px",
            background: "none",
            border: 0,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <UserAvatar email={userEmail} size={24} />
          <span
            style={{
              fontSize: 12.5,
              color: "var(--ms-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {userEmail}
          </span>
          <span style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>
            <EllipsisGlyph size={13} />
          </span>
        </button>
      </div>
    </aside>
  );
}
