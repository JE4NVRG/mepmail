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

// Resend's public list, read on 2026-09-27 (docs/gtm/bench-concorrentes-2026-09.md
// §2.1): the exact column /alternatives/resend publishes.
const RESEND_PUBLIC = [35, 160, 350, 650, 825, 1150];
const ADVANTAGE_PCT = [43, 38, 43, 51, 48, 52];
const ADVANTAGE_USD = ["US$ 15", "US$ 60", "US$ 151", "US$ 331", "US$ 396", "US$ 601"];

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
      "100k",
      "200k",
      "500k",
      "1M",
      "1.5M",
      "2.5M",
    ]);
    expect(RESEND_ROWS.map((row) => formatVolume(row.volume, "pt-BR"))).toEqual([
      "100k",
      "200k",
      "500k",
      "1M",
      "1,5M",
      "2,5M",
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

  it("caps the Resend claim at 52% and the floor at 38%", () => {
    expect(MAX_RESEND_SAVINGS_PCT).toBe(52);
    expect(MIN_RESEND_SAVINGS_PCT).toBe(38);
  });

  it("anchors the headline claim on the most expensive public rung", () => {
    // 60% is SendGrid's 1M rung (US$ 799) against Scale 1M (US$ 319) — never a
    // Resend comparison, which the page says out loud.
    expect(MAX_MARKET_SAVINGS_PCT).toBe(60);
    expect(formatVolume(CLAIM_ANCHOR_ROW.volume, "en")).toBe("1M");
    expect(CLAIM_ANCHOR_ROW.sendgrid).toBe(799);
    expect(CLAIM_ANCHOR_ROW.mepmail).toBe(319);
  });
});
