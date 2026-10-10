import { ImageResponse } from "next/og";
import { getLocale, getTranslations } from "next-intl/server";
import { formatUsd } from "@/lib/landing-pricing";
import { CORREIO_FROM_CENTS, LAUNCH_OFFER } from "@/lib/launch-offer";
import type { AgentDemoLabels } from "./agent-demo";

/**
 * The /correio share image: the launch line and the same agent scene as the
 * hero (message in, draft, waiting for approval), in the visitor's language.
 * Locale comes from the request, like the page's own title and description.
 */
export const alt = "MepMail Correio";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = {
  ground: "#000000",
  panel: "#0c0c0d",
  line: "#2a2a2e",
  bone: "#f4f1ea",
  muted: "#a19d94",
  violet: "#c0a8e1",
  warn: "#f2c86b",
};

export default async function Image() {
  const [t, locale] = await Promise.all([getTranslations("correio"), getLocale()]);
  const demo = t.raw("demo") as AgentDemoLabels;
  const standaloneOpen =
    process.env.MAILBOX_EARLY_ACCESS_OPEN === "true" &&
    process.env.MAILBOX_STANDALONE_OPEN === "true";
  const price = formatUsd(
    (standaloneOpen
      ? CORREIO_FROM_CENTS
      : Math.min(...LAUNCH_OFFER.mailboxes.map((box) => box.monthlyCents))) / 100,
    locale,
  );

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        padding: "64px 72px",
        background: INK.ground,
        color: INK.bone,
        fontSize: 28,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 600, paddingRight: 48 }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 26, color: INK.muted }}>
          <span style={{ color: INK.bone, fontWeight: 700 }}>MepMail</span>
          <span
            style={{
              marginLeft: 16,
              padding: "4px 14px",
              borderRadius: 999,
              background: INK.violet,
              color: INK.ground,
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            {t("og.badge")}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 44,
            fontSize: 60,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -1.5,
          }}
        >
          {t("og.title")}
        </div>
        <div style={{ display: "flex", marginTop: 28, color: INK.muted, lineHeight: 1.4 }}>
          {t("og.body")}
        </div>
        <div style={{ display: "flex", marginTop: "auto", color: INK.violet, fontSize: 26 }}>
          {t("og.price", { price })}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          border: `1px solid ${INK.line}`,
          borderRadius: 20,
          background: INK.panel,
          padding: 24,
          fontSize: 22,
        }}
      >
        <div style={{ display: "flex", color: INK.muted, fontSize: 18 }}>{demo.inbox}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 18,
            padding: 16,
            border: `1px solid ${INK.line}`,
            borderRadius: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              borderRadius: 999,
              border: `1px solid ${INK.line}`,
              fontSize: 16,
            }}
          >
            {demo.initials}
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 14 }}>
            <span style={{ fontWeight: 700 }}>{demo.sender}</span>
            <span style={{ color: INK.muted, fontSize: 19 }}>{demo.preview}</span>
          </div>
        </div>
        <div style={{ display: "flex", marginTop: 22, color: INK.muted, fontSize: 18 }}>
          {demo.agent}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 12,
            padding: 16,
            border: `1px solid ${INK.line}`,
            borderRadius: 14,
            lineHeight: 1.4,
          }}
        >
          {demo.reply}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            marginTop: 18,
          }}
        >
          <span
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              border: `1px solid ${INK.warn}`,
              color: INK.warn,
              fontSize: 18,
            }}
          >
            {demo.awaiting}
          </span>
          <span
            style={{
              marginTop: 12,
              padding: "6px 14px",
              borderRadius: 10,
              border: `1px solid ${INK.line}`,
              fontSize: 18,
            }}
          >
            {demo.approve}
          </span>
        </div>
      </div>
    </div>,
    size,
  );
}
