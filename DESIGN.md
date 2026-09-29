---
version: 1.1
name: MepMail-design
description: Product-led marketing for builders and AI agents. Dark canvas, bone text, steel and restrained violet accents. Executable tokens live in apps/web/src/styles/tokens/colors.css.
colors:
  primary: "#7f8791"
  primary-soft: "#c0a8e1"
  on-primary: "#000000"
  ink: "#f4f1ea"
  body: "#918f89"
  marketing-body: "#aaa7a0"
  mute: "#5a5854"
  hairline: "#1f1f22"
  hairline-strong: "#2a2a2e"
  canvas: "#000000"
  canvas-soft: "#050505"
  panel: "#0c0c0d"
  panel-raised: "#131316"
  success: "#5fce8b"
  info: "#7ea6db"
  warn: "#d9ae5f"
  danger: "#e07f76"
---

# MepMail design language

This document reconciles the former reference-derived green prose with the real MepMail tokens. VoltAgent is not the brand. Green is semantic success only; violet is a restrained accent, never a full headline.

## Marketing typography and rhythm

Use existing locally available sans and monospace stacks. No external fonts. Hero: 68–76px desktop, 40–46px mobile, weight 500–600, line-height 1.04. Body lead: 18px/1.55. Section headings: 32–44px with controlled width. Code examples use the existing monospace stack.

The content container is approximately 1180px with 20px mobile and 32px desktop gutters. Sections use 64–88px desktop and 48px mobile spacing. Use hairline borders and 12–16px card radii, without decorative gradients, parallax or blocking animation. Marketing secondary text may use #aaa7a0 scoped to the landing, not authenticated UI.

## Hero and product evidence

Lead with the user outcome, not infrastructure. The primary action is a bone-on-dark signup button; secondary is outline/ghost linking to the real product section. At 390×844, the primary action must end above y=600. Text and actions precede product imagery on mobile.

Only real product screenshots: crop away sidebar, account identity and all PII; record provenance and dimensions. No dashboard simulations, delivery counters, customer logos or invented testimonials. Tool logos indicate integrations/compatibility, not customers.

## Header and footer v2

Preserve the existing PublicHeader/PublicFooter and navigation. Sticky blurred dark header, flat links, language selector, sign-in and signup. Below 880px the menu collapses; Escape closes it and keyboard focus stays visible. Footer retains Product, Compare, Account and Legal, docs/security/support routes and GitHub medallion. No restoration of obsolete navigation restrictions from the earlier reference document.

## Components and accessibility

Product benefits form an editorial sequence, not a generic icon wall. Integration tabs expose API, SMTP and Agents with ARIA tabs, arrow/Home/End navigation and visible focus. Examples are explicitly labeled, never simulated successful network responses. MCP configuration copy preserves analytics events.

Plans derive from the shared catalog: Free, Starter and Pro 110K upfront; remaining volumes remain accessible. Editorial feature badge means "For growth", not a claim about popularity. Comparison follows plans with its calculator, dated caveat and native details disclosure. FAQs use native details.

## Guardrails and scope

No global authenticated-UI restyling; no new dependencies, guaranteed delivery, isolated shared-IP reputation, MCP exclusivity or untested setup-time promises. Keep EN default and full PT parity. Preserve AGPL/NOTICE and logo licenses. Full direction: docs/gtm/landing-cro-spec.md; scope constitution: specs/constitution.md.
