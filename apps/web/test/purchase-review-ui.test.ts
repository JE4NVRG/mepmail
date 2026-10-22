import type { PurchaseEligibility } from "@millionsend/billing";
import { createTranslator } from "next-intl";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseReviewNotice, usePurchaseReview } from "@/components/purchase-review-notice";
import enSettings from "../messages/en/settings.json";
import ptSettings from "../messages/pt-BR/settings.json";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  data: undefined as PurchaseEligibility | undefined,
  pending: false,
  queryError: false,
  requestPending: false,
  requestSuccess: false,
  requestError: false,
  mutate: vi.fn(),
  refetch: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  queryOptions: vi.fn(),
  mutationOptions: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "purchase-review-fixture",
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: () =>
    createTranslator({
      locale: h.locale,
      messages: { settings: h.locale === "en" ? enSettings : ptSettings },
      namespace: "settings.billing.purchaseReview",
    }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));
vi.mock("@/components/spinner", () => ({ BtnSpinner: () => null }));
vi.mock("@/components/signup-review-request", () => ({
  SignupReviewRequest: () => createElement("div", { "data-manual-review": true }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    billing: {
      purchaseEligibility: {
        queryOptions: h.queryOptions,
        queryKey: () => ["billing", "purchaseEligibility"],
      },
      requestPurchaseReview: { mutationOptions: h.mutationOptions },
    },
    team: { standing: { queryFilter: () => ({ queryKey: ["team", "standing"] }) } },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: h.data,
    isPending: h.pending,
    isError: h.queryError,
    isFetching: h.pending,
    refetch: h.refetch,
  }),
  useMutation: () => ({
    isPending: h.requestPending,
    isSuccess: h.requestSuccess,
    isError: h.requestError,
    mutate: h.mutate,
  }),
  useQueryClient: () => ({
    setQueryData: h.setQueryData,
    invalidateQueries: h.invalidateQueries,
  }),
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render(enabled = true) {
  const review = usePurchaseReview(enabled);
  const tree = PurchaseReviewNotice({ review });
  return { review, tree, html: renderToStaticMarkup(tree) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.data = {
    eligible: false,
    code: "domain_review",
    domains: ["verifiedsender.online"],
    reviewReason: "new_sender",
  };
  h.pending = false;
  h.queryError = false;
  h.requestPending = false;
  h.requestSuccess = false;
  h.requestError = false;
  h.queryOptions.mockImplementation((_input, options) => options);
  h.mutationOptions.mockImplementation((options) => options);
});

describe.each(["en", "pt-BR"] as const)("purchase safety notice in %s", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });
  const messages = (locale === "en" ? enSettings : ptSettings).billing.purchaseReview;

  it("blocks a domain under review, explains the reason and offers review before payment", () => {
    const { review, tree, html } = render();
    expect(review.allowed).toBe(false);
    expect(html).toContain(messages.reasons.domain_review);
    expect(html).toContain("verifiedsender.online");
    expect(html).toContain(messages.beforePayment);
    expect(html).toContain('role="status"');
    const request = nodes(tree).find(
      (node) =>
        node.type === "button" &&
        Array.isArray(node.props.children) &&
        node.props.children.includes(messages.request),
    );
    expect(request?.props.disabled).toBe(false);
    (request?.props.onClick as () => void)();
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(h.setQueryData).not.toHaveBeenCalled();
  });

  it("keeps payment blocked while eligibility or review preparation is pending", () => {
    h.data = undefined;
    h.pending = true;
    let outcome = render();
    expect(outcome.review.allowed).toBe(false);
    expect(outcome.html).toContain(messages.checking);
    expect(
      nodes(outcome.tree)
        .filter((node) => node.type === "button")
        .every((node) => node.props.disabled === true),
    ).toBe(true);
    h.pending = false;
    h.data = {
      eligible: true,
      code: "ready",
      domains: ["sender.example.test"],
      reviewReason: null,
    };
    h.requestPending = true;
    outcome = render();
    expect(outcome.review.allowed).toBe(false);
    expect(outcome.html).toContain(messages.checking);
  });

  it("allows approved readiness and does not apply a new-purchase notice when disabled", () => {
    h.data = {
      eligible: true,
      code: "ready",
      domains: ["sender.example.test"],
      reviewReason: null,
    };
    expect(render().review.allowed).toBe(true);
    expect(render().html).toBe("");
    h.data = undefined;
    h.pending = true;
    expect(render(false).review.allowed).toBe(true);
    expect(render(false).html).toBe("");
    expect(h.queryOptions).toHaveBeenLastCalledWith(undefined, { enabled: false, retry: false });
  });

  it("links a missing domain to verification and keeps a failed read blocked with recovery", () => {
    h.data = { eligible: false, code: "domain_required", domains: [], reviewReason: null };
    let outcome = render();
    expect(outcome.review.allowed).toBe(false);
    expect(outcome.html).toContain('href="/domains"');
    expect(outcome.html).toContain(messages.verifyDomain);
    h.queryError = true;
    outcome = render();
    expect(outcome.review.allowed).toBe(false);
    expect(outcome.html).toContain('role="alert"');
    expect(outcome.html).toContain(messages.failed);
    const retry = nodes(outcome.tree).find(
      (node) =>
        node.type === "button" &&
        Array.isArray(node.props.children) &&
        node.props.children.includes(messages.retry),
    );
    (retry?.props.onClick as () => void)();
    expect(h.refetch).toHaveBeenCalledOnce();
  });

  it("updates the safe snapshot after preparation and still requires manual approval", async () => {
    render();
    const options = h.mutationOptions.mock.calls[0]?.[0] as {
      onSuccess: (result: PurchaseEligibility) => Promise<void>;
    };
    if (!h.data) throw new Error("Missing denied fixture");
    await options.onSuccess(h.data);
    expect(h.setQueryData).toHaveBeenCalledExactlyOnceWith(
      ["billing", "purchaseEligibility"],
      h.data,
    );
    expect(h.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["team", "standing"] });
    h.requestSuccess = true;
    const outcome = render();
    expect(outcome.review.allowed).toBe(false);
    expect(outcome.html).toContain('data-manual-review="true"');
    expect(outcome.html).not.toContain(messages.request);
  });
});
