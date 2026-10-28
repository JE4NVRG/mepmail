// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConsentReviewPanel } from "../src/components/campaign-consent";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it.each(["en", "pt-BR"])(
  "renders accessible evidence form, preserves input on error and never offers owner approval (%s)",
  async (locale) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSubmit = vi.fn();
    await act(async () =>
      root.render(
        createElement(ConsentReviewPanel, {
          locale,
          dossier: null,
          allowed: false,
          busy: false,
          error: "Synthetic validation refusal",
          onSubmit,
        }),
      ),
    );
    expect(host.querySelectorAll("label").length).toBeGreaterThanOrEqual(9);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Synthetic validation refusal");
    expect(host.textContent).not.toContain(
      locale === "en" ? "Approve evidence" : "Aprovar evidência",
    );
    const values: Record<string, string> = {
      listReference: "list-***42",
      source: "Direct first-party signup from website",
      method: "Unchecked consent checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive the monthly product newsletter.",
      permissionScope: "Monthly product newsletter only",
      reference: "sample-***42",
      registeredAt: "2026-01-01T12:00",
    };
    for (const [name, value] of Object.entries(values))
      (host.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    const form = host.querySelector("form");
    if (!form) throw new Error("Synthetic consent form not rendered");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        listReference: "list-***42",
        samples: [expect.objectContaining({ ipAvailable: false, reference: "sample-***42" })],
      }),
    );
    expect((host.querySelector('[name="source"]') as HTMLInputElement).value).toBe(values.source);
    await act(async () => root.unmount());
    host.remove();
  },
);
it("operator approval and revocation require a meaningful reason", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const onReview = vi.fn();
  await act(async () =>
    root.render(
      createElement(ConsentReviewPanel, {
        locale: "en",
        dossier: {
          id: "synthetic",
          status: "pending",
          submittedAt: new Date(),
          reviewedAt: null,
          reason: null,
          evidence: {
            listReference: "list-***42",
            source: "first party",
            method: "checkbox",
            formUrl: "https://example.test",
            permissionText: "opt in",
            permissionScope: "news",
            samples: [],
          },
        },
        allowed: false,
        busy: false,
        onReview,
      }),
    ),
  );
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  expect(host.textContent).toContain("does not release held mail");
  await act(async () => root.unmount());
});
