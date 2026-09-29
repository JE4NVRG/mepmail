import { describe, expect, it } from "vitest";
import {
  CLAIM_ANCHOR_ROW,
  MAX_MARKET_SAVINGS_PCT,
  MAX_RESEND_SAVINGS_PCT,
  MIN_RESEND_SAVINGS_PCT,
  RESEND_ROWS,
  resendSavings,
} from "../src/lib/alternatives-resend";
import { formatUsd, formatVolume, PRICE_ROWS } from "../src/lib/landing-pricing";

// Resend's column for the published rungs (docs/gtm/bench-concorrentes-2026-09.md
// §2.1): the cheapest published way to send each volume — Resend's Pro 100K rung
// plus its published overage where that is cheaper than the next rung up. The
// exact column /alternatives/resend publishes.
const RESEND_PUBLIC = [44, 143, 385, 715, 903, 1265];
const ADVANTAGE_PCT = [55, 30, 48, 55, 52, 57];
const ADVANTAGE_USD = ["US$ 24", "US$ 43", "US$ 186", "US$ 396", "US$ 474", "US$ 716"];

describe("Resend comparison data", () => {
  it("publishes Resend's public prices, volume by volume", () => {
    expect(RESEND_ROWS.map((row) => row.resend)).toEqual(RESEND_PUBLIC);
  });

  it("derives every row from the shared price table instead of copying it", () => {
    expect(RESEND_ROWS.map((row) => [row.volume, row.mepmail])).toEqual(
      PRICE_ROWS.map((row) => [row.volume, row.mepmail]),
    );
  });

  it("labels the volumes from the shared volumes in the reader's locale", () => {
    expect(RESEND_ROWS.map((row) => formatVolume(row.volume, "en"))).toEqual([
      "110k",
      "220k",
      "550k",
      "1.1M",
      "1.65M",
      "2.75M",
    ]);
    expect(RESEND_ROWS.map((row) => formatVolume(row.volume, "pt-BR"))).toEqual([
      "110k",
      "220k",
      "550k",
      "1,1M",
      "1,65M",
      "2,75M",
    ]);
  });

  it("computes the advantage instead of typing it", () => {
    expect(RESEND_ROWS.map((row) => resendSavings(row).pct)).toEqual(ADVANTAGE_PCT);
    expect(RESEND_ROWS.map((row) => formatUsd(resendSavings(row).usd, "en"))).toEqual(
      ADVANTAGE_USD,
    );
  });

  it("never claims a saving above the data", () => {
    for (const row of RESEND_ROWS) {
      const savings = resendSavings(row);
      expect(savings.usd, `${row.volume} vs Resend`).toBeGreaterThan(0);
      expect(savings.pct, `${row.volume} vs Resend`).toBeLessThanOrEqual(MAX_RESEND_SAVINGS_PCT);
    }
  });

  it("caps the Resend claim at 57% and the floor at 30%", () => {
    expect(MAX_RESEND_SAVINGS_PCT).toBe(57);
    expect(MIN_RESEND_SAVINGS_PCT).toBe(30);
  });

  it("anchors the headline claim on the most expensive public rung", () => {
    // 60% is SendGrid's 1.5M rung (US$ 799) against Scale 1.1M (US$ 319) — never
    // a Resend comparison, which the page says out loud.
    expect(MAX_MARKET_SAVINGS_PCT).toBe(60);
    expect(formatVolume(CLAIM_ANCHOR_ROW.volume, "en")).toBe("1.1M");
    expect(CLAIM_ANCHOR_ROW.sendgrid).toBe(799);
    expect(CLAIM_ANCHOR_ROW.mepmail).toBe(319);
  });
});
