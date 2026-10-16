import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: "en", replace: vi.fn(), refresh: vi.fn(), cookie: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));
vi.mock("next-intl", () => ({ useLocale: () => h.locale }));
vi.mock("@/lib/locale-cookie", () => ({ LOCALES: ["en", "pt-BR"], setLocaleCookie: h.cookie }));

import { LandingLangSwitch } from "@/components/landing-lang-switch";

function choose(locale: string) {
  const element = LandingLangSwitch({ label: "Language" });
  const buttons = element.props.children[1] as ReactElement<{
    children: string;
    onClick: () => void;
  }>[];
  const button = buttons.find((item) => item.props.children === (locale === "en" ? "EN" : "PT"));
  expect(button).toBeDefined();
  button?.props.onClick();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("public language switch navigation", () => {
  it("takes a plain English pricing URL to Portuguese while keeping campaign and fragment", () => {
    h.locale = "en";
    vi.stubGlobal("window", {
      location: { href: "https://mepmail.dev/pricing?utm_source=fixture#plans" },
    });
    choose("pt-BR");
    expect(h.cookie).toHaveBeenCalledWith("pt-BR");
    expect(h.replace).toHaveBeenCalledWith("/pricing?utm_source=fixture&lang=pt-BR#plans");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("returns Portuguese to its plain English canonical without dropping other parameters", () => {
    h.locale = "pt-BR";
    vi.stubGlobal("window", {
      location: { href: "https://mepmail.dev/correio?lang=pt-BR&focus=mail" },
    });
    choose("en");
    expect(h.replace).toHaveBeenCalledWith("/correio?focus=mail");
  });

  it("keeps preference-only refresh on utility/private URLs", () => {
    h.locale = "en";
    vi.stubGlobal("window", { location: { href: "https://mepmail.dev/login?next=%2Femails" } });
    choose("pt-BR");
    expect(h.cookie).toHaveBeenCalledWith("pt-BR");
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
