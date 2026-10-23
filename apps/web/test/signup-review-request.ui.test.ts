import { createTranslator } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignupReviewRequest } from "@/components/signup-review-request";
import en from "../messages/en/console.json";
import pt from "../messages/pt-BR/console.json";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  cachedPending: false,
  serverPending: false,
  queryError: false,
  request: vi.fn(),
  refetch: vi.fn(),
  setQueryData: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "request-form",
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = h.stateIndex++;
    if (!(index in h.states)) h.states[index] = initial;
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.refIndex++;
    h.refs[index] ??= { current: initial };
    return h.refs[index];
  },
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: () =>
    createTranslator({
      locale: h.locale,
      messages: { console: h.locale === "en" ? en : pt },
      namespace: "console.banner.reviewRequest",
    }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    team: {
      signupReview: { queryOptions: () => ({}), queryKey: () => ["team", "signupReview"] },
      requestSignupReview: { mutationOptions: () => ({}) },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { pending: h.cachedPending, requestedAt: null },
    isPending: false,
    isError: h.queryError,
    refetch: h.refetch,
  }),
  useMutation: () => ({ isPending: false, mutateAsync: h.request }),
  useQueryClient: () => ({ setQueryData: h.setQueryData }),
}));

type Node = ReactElement<Record<string, unknown>>;
type Props = NonNullable<Parameters<typeof SignupReviewRequest>[0]>;
const CONTEXT = "Receipts for customers who explicitly requested their purchase confirmation.";
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render(props: Props = {}) {
  h.stateIndex = 0;
  h.refIndex = 0;
  return SignupReviewRequest(props);
}
function find(tree: ReactNode, type: string) {
  const node = nodes(tree).find((entry) => entry.type === type);
  if (!node) throw new Error(`${type} missing`);
  return node;
}
function fill(props: Props = {}) {
  const tree = render(props);
  (find(tree, "button").props.onClick as () => void)();
  const form = render(props);
  (find(form, "input").props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: CONTEXT },
  });
  return render(props);
}
function submit(tree: ReactNode) {
  return (
    find(tree, "form").props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>
  )({
    preventDefault: () => {},
  });
}
function text(tree: ReactNode): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (!tree || typeof tree !== "object" || !("props" in tree)) return "";
  return text((tree as Node).props.children as ReactNode);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.states = [];
  h.refs = [];
  h.cachedPending = false;
  h.serverPending = false;
  h.queryError = false;
  h.refetch.mockImplementation(async () => {
    h.cachedPending = h.serverPending;
    return { isError: false, data: { pending: h.serverPending, requestedAt: null } };
  });
  h.request.mockImplementation(async () => {
    h.serverPending = true;
    return { pending: true, requestedAt: new Date() };
  });
  h.setQueryData.mockImplementation((_key, receipt: { pending: boolean }) => {
    h.cachedPending = receipt.pending;
  });
});

describe.each(["en", "pt-BR"] as const)("explicit review submission in %s", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });
  const copy = (locale === "en" ? en : pt).banner.reviewRequest;

  it("opens the form without preparing a hold or sending a request", () => {
    const prepare = vi.fn(async () => true);
    const tree = fill({ beforeSubmitAction: prepare });
    expect(find(tree, "button").props["aria-expanded"]).toBe(true);
    expect(text(tree)).toContain(copy.hint);
    expect(text(tree)).not.toContain(copy.received);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("prepares before submission, prevents double submit and restores the persisted receipt on reload", async () => {
    let finish: ((ready: boolean) => void) | undefined;
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const props = { beforeSubmitAction: prepare };
    const tree = fill(props);
    const work = submit(tree);
    await submit(tree);
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    const waiting = render(props);
    expect(find(waiting, "form").props["aria-busy"]).toBe(true);
    expect(find(waiting, "input").props.disabled).toBe(true);
    expect(text(waiting)).not.toContain(copy.received);
    if (!finish) throw new Error("Preparation did not start");
    finish(true);
    await work;
    expect(h.request).toHaveBeenCalledExactlyOnceWith({ context: CONTEXT });
    expect(h.setQueryData).toHaveBeenCalledWith(
      ["team", "signupReview"],
      expect.objectContaining({ pending: true }),
    );
    expect(text(render(props))).toContain(copy.received);
    h.states = [];
    h.refs = [];
    h.cachedPending = h.serverPending;
    const reloaded = render(props);
    expect(text(reloaded)).toContain(copy.received);
    expect(nodes(reloaded).some((node) => node.type === "form" || node.type === "button")).toBe(
      false,
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("does not invent a receipt when preparation finds that approval is already complete", async () => {
    const prepare = vi.fn(async () => false);
    const props = { beforeSubmitAction: prepare };
    await submit(fill(props));
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.setQueryData).not.toHaveBeenCalled();
    expect(text(render(props))).not.toContain(copy.received);
  });

  it("keeps the context and a retryable error when preparation fails", async () => {
    const prepare = vi.fn(async (): Promise<boolean> => {
      throw new Error("Preparation unavailable");
    });
    const props = { beforeSubmitAction: prepare };
    await submit(fill(props));
    const failed = render(props);
    expect(h.request).not.toHaveBeenCalled();
    expect(text(failed)).toContain(copy.failed);
    expect(find(failed, "input").props.value).toBe(CONTEXT);
    expect(text(failed)).not.toContain(copy.received);
    prepare.mockResolvedValueOnce(true);
    await submit(failed);
    expect(text(render(props))).toContain(copy.received);
  });

  it("reconciles a committed request whose response was lost instead of reporting another submission", async () => {
    h.request.mockImplementationOnce(async () => {
      h.serverPending = true;
      throw new Error("Response lost after commit");
    });
    await submit(fill());
    const result = render();
    expect(h.refetch).toHaveBeenCalledOnce();
    expect(text(result)).toContain(copy.received);
    expect(text(result)).not.toContain(copy.failed);
    expect(h.setQueryData).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("never treats preparation alone as a receipt after an uncommitted request failure", async () => {
    h.request.mockRejectedValueOnce(new Error("Request not committed"));
    const prepare = vi.fn(async () => true);
    const props = { beforeSubmitAction: prepare };
    await submit(fill(props));
    const failed = render(props);
    expect(text(failed)).toContain(copy.failed);
    expect(text(failed)).not.toContain(copy.received);
    expect(find(failed, "input").props.value).toBe(CONTEXT);
    await submit(failed);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(text(render(props))).toContain(copy.received);
  });
});
