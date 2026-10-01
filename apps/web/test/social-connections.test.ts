import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocialConnections } from "@/components/auth/social-connections";

// Synthetic component state harness. Real OAuth/state/DB coverage is separate
// in social-linking.test.ts; these tests cover user intent and recovery in the UI.
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  params: new URLSearchParams(),
  query: { data: [] as string[], isPending: false, isError: false },
  options: {} as { enabled: boolean; queryKey: unknown[]; queryFn: () => Promise<string[]> },
  listeners: new Map<string, (event: unknown) => void>(),
  link: vi.fn(),
  list: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] = value;
      },
    ];
  },
  useEffect: (effect: () => unknown) => {
    effect();
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof h.options) => {
    h.options = options;
    return { ...h.query, refetch: h.refetch };
  },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => h.params }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: { provider: string }) =>
    `${key}${args ? `:${args.provider}` : ""}`,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "fixture-user" } } }),
    listAccounts: h.list,
    linkSocial: h.link,
  },
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render() {
  h.cursor = 0;
  return SocialConnections({ providers: { github: true, google: true, microsoft: false } });
}
function github(tree: ReactNode) {
  return nodes(tree).find((node) => node.key === "github")!;
}
const statuses = (tree: ReactNode) => nodes(tree).filter((node) => node.props.role === "status");

beforeEach(() => {
  vi.clearAllMocks();
  h.states = [];
  h.cursor = 0;
  h.params = new URLSearchParams();
  h.query = { data: [], isPending: false, isError: false };
  h.listeners.clear();
  h.link.mockResolvedValue({
    data: { url: "https://github.com/login/oauth/authorize", redirect: true },
    error: null,
  });
  h.list.mockResolvedValue({
    data: [{ providerId: "github", accountId: "private-identity", userId: "fixture-user" }],
    error: null,
  });
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: (event: unknown) => void) => h.listeners.set(name, fn),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("social connections user intent and UI state", () => {
  it("only reads provider names on mount and never initiates linking automatically", async () => {
    render();
    expect(h.link).not.toHaveBeenCalled();
    expect(h.options.queryKey).toEqual(["login-identities", "fixture-user"]);
    expect(await h.options.queryFn()).toEqual(["github"]);
    expect(h.link).not.toHaveBeenCalled();
  });
  it("blocks linking while the account list is loading or failed", () => {
    h.query.isPending = true;
    expect(github(render()).props.disabled).toBe(true);
    h.query.isPending = false;
    h.query.isError = true;
    const tree = render();
    expect(github(tree).props.disabled).toBe(true);
    const retry = nodes(tree).find(
      (node) => node.type === "button" && node.props.children === "retry",
    )!;
    (retry.props.onClick as () => void)();
    expect(h.refetch).toHaveBeenCalledOnce();
    expect(h.link).not.toHaveBeenCalled();
  });
  it("does not trust a success query param without a listed identity", () => {
    h.params = new URLSearchParams({ linkedSocial: "github" });
    expect(statuses(render())).toHaveLength(0);
    h.query.data = ["github"];
    expect(statuses(render())).toHaveLength(1);
    expect(github(render()).props.disabled).toBe(true);
  });
  it("starts linking only on click, with internal fixed return destinations", async () => {
    (github(render()).props.onClick as () => void)();
    await Promise.resolve();
    expect(h.link).toHaveBeenCalledExactlyOnceWith({
      provider: "github",
      callbackURL: "/settings?linkedSocial=github#account-connections",
      errorCallbackURL: "/settings?linkSocial=error#account-connections",
    });
    expect(github(render()).props.disabled).toBe(true);
  });
  it("restores actions after the user goes Back from the provider, without retrying the mutation", async () => {
    (github(render()).props.onClick as () => void)();
    await Promise.resolve();
    expect(github(render()).props.disabled).toBe(true);
    h.listeners.get("pageshow")!({ persisted: true });
    expect(github(render()).props.disabled).toBe(false);
    expect(h.refetch).toHaveBeenCalledOnce();
    expect(h.link).toHaveBeenCalledOnce();
  });
  it("shows a failure and permits an intentional retry if initiating the link fails", async () => {
    h.link.mockResolvedValue({ error: { message: "fixture failure" } });
    (github(render()).props.onClick as () => void)();
    await Promise.resolve();
    const tree = render();
    expect(github(tree).props.disabled).toBe(false);
    expect(
      nodes(tree).some(
        (node) => node.props.role === "alert" && node.props.children === "linkError",
      ),
    ).toBe(true);
  });
  it("does not claim success for a disabled or unknown provider", () => {
    h.query.data = ["microsoft", "unknown"];
    for (const provider of h.query.data) {
      h.params = new URLSearchParams({ linkedSocial: provider });
      expect(statuses(render())).toHaveLength(0);
    }
  });
});
