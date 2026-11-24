"use client";

/**
 * Nav glyphs — bespoke duotone precision icons on a 24×24 viewBox (stroke 1.65 +
 * layered `currentColor` fills), with semantic hover micro-animations driven by
 * `hovered` / `active`. `prefers-reduced-motion` disables all movement.
 */

import { motion, useReducedMotion } from "motion/react";

// --ms-ease; motion needs the raw bezier, not the CSS var.
const EASE: [number, number, number, number] = [0.25, 0, 0.15, 1];
const TR = { duration: 0.4, ease: EASE };

interface GlyphProps {
  on: boolean;
  active: boolean;
  size: number;
}

function duotoneOpacity(on: boolean, active: boolean) {
  if (active) return 0.22;
  if (on) return 0.16;
  return 0.09;
}

function Svg({
  size,
  strokeWidth = 1.65,
  children,
}: {
  size: number;
  strokeWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // display:block — inline SVGs sit on the text baseline and drift ~3px
      // below flex-centered labels; block removes the baseline entirely.
      style={{ flex: "none", display: "block" }}
    >
      {children}
    </svg>
  );
}

function InboxGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <path
        d="M3 13h5.2a1 1 0 0 1 .85.47l.9 1.56a1 1 0 0 0 .85.47h2.4a1 1 0 0 0 .85-.47l.9-1.56a1 1 0 0 1 .85-.47H21v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
        fill="currentColor"
        fillOpacity={fillOpacity}
      />
      <path d="M5 13H3.6a1.6 1.6 0 0 0-1.56 1.94l.9 4.5A2 2 0 0 0 4.9 21h14.2a2 2 0 0 0 1.96-1.56l.9-4.5A1.6 1.6 0 0 0 20.4 13H19" />
      <path d="M3 13h5.2a1 1 0 0 1 .85.47l.9 1.56a1 1 0 0 0 .85.47h2.4a1 1 0 0 0 .85-.47l.9-1.56a1 1 0 0 1 .85-.47H21" />
      <motion.g initial={false} animate={on ? { y: [-1.5, 1.5, 0] } : { y: 0 }} transition={TR}>
        <path d="M12 3v7.5" />
        <path d="m8.75 7.5 3.25 3.25 3.25-3.25" />
      </motion.g>
    </Svg>
  );
}

function EmailsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <rect
        x="2"
        y="4.5"
        width="20"
        height="15"
        rx="2.5"
        fill="currentColor"
        fillOpacity={fillOpacity}
      />
      <rect x="2" y="4.5" width="20" height="15" rx="2.5" />
      <motion.path
        d="m21.5 7.2-8.45 5.4a2 2 0 0 1-2.1 0L2.5 7.2"
        initial={false}
        animate={{ scaleY: on ? -0.75 : 1 }}
        transition={TR}
        style={{ transformBox: "fill-box", transformOrigin: "50% 0%" }}
      />
    </Svg>
  );
}

const RADIO_WAVES = [
  { d: "M7.75 16.25a6 6 0 0 1 0-8.5", delay: 0 },
  { d: "M16.25 7.75a6 6 0 0 1 0 8.5", delay: 0 },
  { d: "M4.93 19.07a10 10 0 0 1 0-14.14", delay: 0.1 },
  { d: "M19.07 4.93a10 10 0 0 1 0 14.14", delay: 0.1 },
];

function BroadcastsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <circle
        cx="12"
        cy="12"
        r="6.5"
        stroke="none"
        fill="currentColor"
        fillOpacity={fillOpacity * 0.85}
      />
      {RADIO_WAVES.map((wave) => (
        <motion.path
          key={wave.d}
          d={wave.d}
          initial={false}
          animate={on ? { opacity: [1, 0.25, 1] } : { opacity: 1 }}
          transition={{ ...TR, delay: wave.delay }}
        />
      ))}
      <motion.circle
        cx="12"
        cy="12"
        r="2.2"
        fill="currentColor"
        fillOpacity={active || on ? 0.55 : 0.3}
        initial={false}
        animate={on ? { scale: [1, 1.28, 1] } : { scale: 1 }}
        transition={TR}
        style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
      />
    </Svg>
  );
}

const TEMPLATE_LINES = [
  { d: "M10.5 9.5H8", delay: 0 },
  { d: "M16 13.5H8", delay: 0.08 },
  { d: "M14.5 17.5H8", delay: 0.16 },
];

function TemplatesGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <path
        d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2z"
        fill="currentColor"
        fillOpacity={fillOpacity}
      />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      {TEMPLATE_LINES.map((line) => (
        <motion.path
          key={line.d}
          d={line.d}
          initial={false}
          animate={on ? { pathLength: [0.15, 1] } : { pathLength: 1 }}
          transition={{ duration: 0.3, ease: EASE, delay: line.delay }}
        />
      ))}
    </Svg>
  );
}

function AudienceGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <circle cx="9" cy="7" r="3.8" fill="currentColor" fillOpacity={fillOpacity} />
      <path
        d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2Z"
        fill="currentColor"
        fillOpacity={fillOpacity}
      />
      <circle cx="9" cy="7" r="3.8" />
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <motion.g
        initial={false}
        animate={on ? { x: [2.2, 0], opacity: [0.3, 1] } : { x: 0, opacity: 1 }}
        transition={TR}
      >
        <path d="M16 3.2a3.8 3.8 0 0 1 0 7.6" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.85" />
      </motion.g>
    </Svg>
  );
}

const METRIC_BARS = [
  { d: "M8 17v-4", delay: 0 },
  { d: "M13 17V6", delay: 0.07 },
  { d: "M18 17v-7", delay: 0.14 },
];

function MetricsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <rect
        x="6"
        y="4"
        width="15"
        height="15"
        rx="2"
        stroke="none"
        fill="currentColor"
        fillOpacity={fillOpacity * 0.7}
      />
      <path d="M3.5 3.5v15a2 2 0 0 0 2 2h15" />
      {METRIC_BARS.map((bar) => (
        <motion.path
          key={bar.d}
          d={bar.d}
          strokeWidth={2}
          initial={false}
          animate={on ? { scaleY: [0.2, 1] } : { scaleY: 1 }}
          transition={{ duration: 0.35, ease: EASE, delay: bar.delay }}
          style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
        />
      ))}
    </Svg>
  );
}

function DomainsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity={fillOpacity} />
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.5 12h19" />
      {/* Meridian is symmetric about x=12, so scaleX -1 lands on the same shape cleanly. */}
      <motion.path
        d="M12 2.5a14 14 0 0 0 0 19 14 14 0 0 0 0-19"
        initial={false}
        animate={{ scaleX: on ? -1 : 1 }}
        transition={{ duration: 0.5, ease: EASE }}
        style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
      />
    </Svg>
  );
}

function LogsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <rect
        width="18"
        height="18"
        x="3"
        y="3"
        rx="3"
        fill="currentColor"
        fillOpacity={fillOpacity}
      />
      <rect width="18" height="18" x="3" y="3" rx="3" />
      <motion.path
        d="m7.5 11.5 2.2-2.2-2.2-2.2"
        initial={false}
        animate={on ? { x: [0, 1.5, 0] } : { x: 0 }}
        transition={TR}
      />
      <motion.path
        d="M11.5 14h5"
        initial={false}
        animate={on ? { opacity: [1, 0.2, 1] } : { opacity: 1 }}
        transition={TR}
      />
    </Svg>
  );
}

function ApiKeysGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={on ? { rotate: [0, -14, 10, 0] } : { rotate: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        style={{ transformBox: "view-box", transformOrigin: "16px 8px" }}
      >
        <path
          d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.2 6.2 0 1 0-4-4Z"
          fill="currentColor"
          fillOpacity={fillOpacity}
        />
        <path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.2 6.2 0 1 0-4-4Z" />
        <circle cx="16.2" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
      </motion.g>
    </Svg>
  );
}

function WebhooksGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={on ? { rotate: [0, -12, 0] } : { rotate: 0 }}
        transition={{ duration: 0.45, ease: EASE }}
        style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
      >
        <circle
          cx="12"
          cy="6.5"
          r="2.2"
          fill="currentColor"
          fillOpacity={fillOpacity}
          stroke="none"
        />
        <circle
          cx="6.2"
          cy="16.8"
          r="2.2"
          fill="currentColor"
          fillOpacity={fillOpacity}
          stroke="none"
        />
        <circle
          cx="17.8"
          cy="16.8"
          r="2.2"
          fill="currentColor"
          fillOpacity={fillOpacity}
          stroke="none"
        />
        <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
        <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
        <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
      </motion.g>
    </Svg>
  );
}

function SettingsGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={{ rotate: on ? 30 : 0 }}
        transition={TR}
        style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
      >
        <path
          d="M9.67 4.14a2.34 2.34 0 0 1 4.66 0 2.34 2.34 0 0 0 3.32 1.91 2.34 2.34 0 0 1 2.33 4.03 2.34 2.34 0 0 0 0 3.84 2.34 2.34 0 0 1-2.33 4.03 2.34 2.34 0 0 0-3.32 1.91 2.34 2.34 0 0 1-4.66 0 2.34 2.34 0 0 0-3.32-1.91 2.34 2.34 0 0 1-2.33-4.03 2.34 2.34 0 0 0 0-3.84 2.34 2.34 0 0 1 2.33-4.03 2.34 2.34 0 0 0 3.32-1.91"
          fill="currentColor"
          fillOpacity={fillOpacity}
        />
        <path d="M9.67 4.14a2.34 2.34 0 0 1 4.66 0 2.34 2.34 0 0 0 3.32 1.91 2.34 2.34 0 0 1 2.33 4.03 2.34 2.34 0 0 0 0 3.84 2.34 2.34 0 0 1-2.33 4.03 2.34 2.34 0 0 0-3.32 1.91 2.34 2.34 0 0 1-4.66 0 2.34 2.34 0 0 0-3.32-1.91 2.34 2.34 0 0 1-2.33-4.03 2.34 2.34 0 0 0 0-3.84 2.34 2.34 0 0 1 2.33-4.03 2.34 2.34 0 0 0 3.32-1.91" />
        <circle cx="12" cy="12" r="3" fill="var(--ms-panel)" />
      </motion.g>
    </Svg>
  );
}

/** Operator console dial: duotone arc with sweeping needle on hover. */
function ConsoleGlyph({ on, active, size }: GlyphProps) {
  const fillOpacity = duotoneOpacity(on, active);
  return (
    <Svg size={size}>
      <path d="M3.34 19a10 10 0 1 1 17.32 0Z" fill="currentColor" fillOpacity={fillOpacity} />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
      <motion.path
        d="m12 14 4-4"
        initial={false}
        animate={{ rotate: on ? -40 : 0 }}
        transition={TR}
        style={{ transformBox: "view-box", transformOrigin: "12px 14px" }}
      />
    </Svg>
  );
}

/** Duotone speech-bubble icon for Support links. */
export function SupportGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path
        d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L4 20l1-4.7A8.5 8.5 0 1 1 21 11.5Z"
        fill="currentColor"
        fillOpacity={0.1}
      />
      <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L4 20l1-4.7A8.5 8.5 0 1 1 21 11.5Z" />
      <circle cx="9.5" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Duotone open-book icon for Documentation links. */
export function DocsGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path
        d="M3 4h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6v15h-6a3 3 0 0 0-3 2 3 3 0 0 0-3-2H3Z"
        fill="currentColor"
        fillOpacity={0.1}
      />
      <path d="M12 7v14M3 4h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6v15h-6a3 3 0 0 0-3 2 3 3 0 0 0-3-2H3Z" />
    </Svg>
  );
}

/** Duotone source/code badge for AGPL-3.0 download link. */
export function SourceGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect
        x="2.5"
        y="4.5"
        width="19"
        height="15"
        rx="3"
        stroke="none"
        fill="currentColor"
        fillOpacity={0.09}
      />
      <path d="m8 8.5-4 3.5 4 3.5m8-7 4 3.5-4 3.5m-3-8.5-2 10" />
    </Svg>
  );
}

/** Magnifying-glass glyph for command search trigger. */
export function SearchGlyph({ size = 14 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.75}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

/** Compact diagonal arrow hinting an external/new-tab destination. */
export function ExternalArrowGlyph({ size = 12 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.75}>
      <path d="M7 17 17 7" />
      <path d="M8.5 7H17v8.5" />
    </Svg>
  );
}

/** Compact left arrow for "back to dashboard" links. */
export function BackArrowGlyph({ size = 15 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.75}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </Svg>
  );
}

/** Static code glyph (lucide code-xml) for the square </> icon buttons. */
export function CodeGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </Svg>
  );
}

/**
 * Canonical dropdown/disclosure chevron (the Select trigger's glyph) — never
 * a text "⌄". Inherits currentColor; `direction="up"` rotates 180° with a
 * transition so open/close flips animate.
 */
export function ChevronGlyph({
  size = 12,
  direction = "down",
}: {
  size?: number;
  direction?: "down" | "up";
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        flex: "none",
        display: "block",
        transform: direction === "up" ? "rotate(180deg)" : "none",
        transition: "transform var(--ms-dur-fast) var(--ms-ease)",
      }}
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Static three-line menu glyph for the mobile nav toggle. */
export function MenuGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.85}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </Svg>
  );
}

/** Static plus glyph for "add / create" buttons — never a text "+" in labels. */
export function PlusGlyph({ size = 14 }: { size?: number }) {
  return (
    // Heavier stroke so the glyph reads as bold as the 600-weight label beside it.
    <Svg size={size} strokeWidth={2.2}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Svg>
  );
}

const GLYPHS = {
  inbox: InboxGlyph,
  emails: EmailsGlyph,
  broadcasts: BroadcastsGlyph,
  templates: TemplatesGlyph,
  audience: AudienceGlyph,
  metrics: MetricsGlyph,
  domains: DomainsGlyph,
  logs: LogsGlyph,
  "api-keys": ApiKeysGlyph,
  webhooks: WebhooksGlyph,
  settings: SettingsGlyph,
  console: ConsoleGlyph,
} as const;

export type NavIconName = keyof typeof GLYPHS;

export function NavGlyph({
  name,
  hovered = false,
  active = false,
  size = 16,
}: {
  name: NavIconName;
  hovered?: boolean;
  active?: boolean;
  size?: number;
}) {
  const reduced = useReducedMotion();
  const Glyph = GLYPHS[name];
  return <Glyph on={hovered && !(reduced ?? false)} active={active} size={size} />;
}

/** Three-dot overflow glyph — replaces text ellipsis in menu triggers. */
export function EllipsisGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
