import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes.json";
import pt from "../messages/pt-BR/mailboxes.json";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  states: [] as unknown[],
  stateIndex: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  service: {} as Record<string, unknown>,
  receiving: {} as Record<string, unknown>,
  billing: {} as Record<string, unknown>,
  activatePending: false,
  activate: vi.fn(),
  create: vi.fn(),
  refetch: vi.fn(),
  changed: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  setQueryData: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.stateIndex++;
    if (!Object.hasOwn(h.states, index)) h.states[index] = initial;
    return [
      h.states[index],
      (next: unknown) => {
        h.states[index] = typeof next === "function" ? next(h.states[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.refIndex++;
    const existing = h.refs[index];
    if (existing) return existing;
    const ref = { current: initial };
    h.refs[index] = ref;
    return ref;
  },
  useEffect: vi.fn(),
  useId: () => "fixture-setup",
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next-intl", () => ({
  useLocale: () => h.locale,
  useTranslations: (namespace: string) => (key: string) => {
    if (namespace === "mailboxes.setup") {
      const catalog = h.locale === "pt-BR" ? pt : en;
      return (
        key
          .split(".")
          .reduce<unknown>(
            (value, segment) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[segment]
                : undefined,
            catalog.setup,
          ) ?? key
      );
    }
    return key;
  },
}));
vi.mock("@/lib/trpc", () => {
  const operation = (fixture: string) => ({
    queryOptions: () => ({ fixture }),
    mutationOptions: () => ({ fixture }),
    queryKey: (input?: unknown) => [fixture, input],
  });
  return {
    useTRPC: () => ({
      mailboxes: {
        service: operation("service"),
        create: operation("create"),
        verifyReceiving: operation("activate"),
        receiving: operation("receiving"),
        billing: operation("billing"),
      },
    }),
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ fixture }: { fixture: string }) => ({
    data: fixture === "service" ? h.service : fixture === "receiving" ? h.receiving : h.billing,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: h.refetch,
  }),
  useMutation: ({ fixture }: { fixture: string }) => ({
    isPending: fixture === "activate" && h.activatePending,
    mutateAsync: fixture === "activate" ? h.activate : h.create,
  }),
  useQueryClient: () => ({ invalidateQueries: h.invalidate, setQueryData: h.setQueryData }),
}));

const { MailboxSetupDialog } = await import(
  "../src/app/(dashboard)/mailboxes/mailbox-setup-dialog"
);
// Controlled hook/query boundaries exercise the real JSX and event handlers.
// This is the UI contract; PGlite activation tests qualify server authority separately.
type Node = ReactElement<Record<string, unknown>>;
const domainId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  return text((value as Node).props.children as ReactNode);
}
const options = {
  domains: [{ id: domainId, name: "fixture.example.invalid", status: "verified" }],
  members: [{ id: "fixture_owner", name: "Fixture", email: "fixture@example.invalid" }],
  currentUserId: "fixture_owner",
} as Parameters<typeof MailboxSetupDialog>[0]["options"];
function render(existingMailbox?: Parameters<typeof MailboxSetupDialog>[0]["existingMailbox"]) {
  h.stateIndex = 0;
  h.refIndex = 0;
  return MailboxSetupDialog({
    options,
    close: h.close,
    changed: h.changed,
    reviewLicense: vi.fn(),
    ...(existingMailbox ? { existingMailbox } : {}),
  });
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((node) => node.type === "button" && text(node) === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => void)();
const copy = () => (h.locale === "pt-BR" ? pt : en).setup;
const readyResult = () => ({
  ...h.receiving,
  state: "ready",
  mailboxes: [
    {
      id: mailboxId,
      address: "luna@fixture.example.invalid",
      receiving_state: "ready",
      reasons: [],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.locale = "en";
  h.states = [];
  h.refs = [];
  h.activatePending = false;
  h.states[7] = { id: mailboxId, address: "luna@fixture.example.invalid" };
  h.service = {
    active: true,
    resourcePolicyActive: true,
    seats: 1,
    reservedSeats: 1,
    licenseKind: "subscription",
    unlimitedSeats: false,
  };
  h.billing = { sendingPlanRequired: false, earlyAccessRequired: false };
  h.receiving = {
    domainId,
    state: "needs_activation",
    mxHost: "inbound-smtp.us-east-1.amazonaws.com",
    mx: { status: "ready" },
    mailboxes: [
      {
        id: mailboxId,
        address: "luna@fixture.example.invalid",
        receiving_state: "reserved",
        reasons: ["recipient_not_enabled"],
      },
    ],
  };
  h.refetch.mockResolvedValue({});
  h.changed.mockResolvedValue(undefined);
  h.invalidate.mockResolvedValue(undefined);
  h.setQueryData.mockImplementation((_key: unknown, result: Record<string, unknown>) => {
    h.receiving = result;
  });
  h.activate.mockImplementation(async () => readyResult());
  h.create.mockResolvedValue({ id: mailboxId });
});

describe("explicit receiving action in the real setup dialog", () => {
  it.each(["en", "pt-BR"] as const)(
    "labels the explicit action in %s and does not activate on render",
    (locale) => {
      h.locale = locale;
      const tree = render();
      expect(button(tree, copy().activateReceiving).props.disabled).toBe(false);
      expect(text(tree)).toContain(copy().activationHint);
      expect(h.activate).not.toHaveBeenCalled();
    },
  );
  it.each(["inactive", "resource-policy", "mx", "unlicensed", "owner", "already-ready"] as const)(
    "does not activate a mailbox with %s readiness",
    (condition) => {
      if (condition === "inactive") h.service.active = false;
      if (condition === "resource-policy") h.service.resourcePolicyActive = false;
      if (condition === "mx") h.receiving.mx = { status: "conflict" };
      if (condition === "unlicensed" || condition === "owner")
        h.receiving.mailboxes = [
          {
            id: mailboxId,
            receiving_state: "reserved",
            reasons: [condition === "owner" ? "owner_inactive" : "seat_not_licensed"],
          },
        ];
      if (condition === "already-ready")
        h.receiving.mailboxes = [{ id: mailboxId, receiving_state: "ready", reasons: [] }];
      const activate = button(render(), copy().activateReceiving);
      expect(activate.props.disabled).toBe(true);
      click(activate);
      expect(h.activate).not.toHaveBeenCalled();
    },
  );
  it("refreshes receiving without silently activating", () => {
    click(button(render(), copy().checkReceiving));
    expect(h.refetch).toHaveBeenCalledOnce();
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("resumes an existing reservation after leaving to configure DNS without recreating or purchasing", async () => {
    h.states = [];
    const existing = {
      id: mailboxId,
      domainId,
      kind: "agent" as const,
      address: "luna@fixture.example.invalid",
    };
    const tree = render(existing);
    expect(nodes(tree).some((node) => node.type === "form")).toBe(false);
    expect(text(tree)).toContain(existing.address);
    expect(h.create).not.toHaveBeenCalled();
    click(button(tree, copy().activateReceiving));
    await vi.waitFor(() => expect(h.activate).toHaveBeenCalledExactlyOnceWith({ domainId }));
    expect(h.create).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });
  it.each(["sending", "cohort"] as const)(
    "keeps a resumed reservation readable while its %s admission is unavailable",
    (reason) => {
      h.states = [];
      h.billing = {
        sendingPlanRequired: reason === "sending",
        earlyAccessRequired: reason === "cohort",
      };
      const existing = {
        id: mailboxId,
        domainId,
        kind: "person" as const,
        address: "luna@fixture.example.invalid",
      };
      const tree = render(existing);
      const activate = button(tree, copy().activateReceiving);
      expect(activate.props.disabled).toBe(true);
      click(activate);
      expect(h.activate).not.toHaveBeenCalled();
      expect(text(tree)).toContain(existing.address);
    },
  );
  it("keeps the new address reserved and refreshes readiness after creation without activation", async () => {
    h.states = [3, domainId, "luna", "Luna", "agent", "fixture_owner"];
    h.service.reservedSeats = 0;
    const form = nodes(render()).find((node) => node.type === "form");
    if (!form) throw new Error("Missing setup form");
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: vi.fn(),
    });
    await vi.waitFor(() => expect(h.changed).toHaveBeenCalledWith(mailboxId));
    expect(h.invalidate.mock.calls.some(([argument]) => argument.queryKey[0] === "receiving")).toBe(
      true,
    );
    expect(h.activate).not.toHaveBeenCalled();
    expect(text(render())).toContain("luna@fixture.example.invalid");
  });
  it("uses the mutation once, announces pending and prevents duplicate clicks", async () => {
    let finish: ((value: Record<string, unknown>) => void) | undefined;
    h.activate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const activate = button(render(), copy().activateReceiving);
    click(activate);
    click(activate);
    expect(h.activate).toHaveBeenCalledExactlyOnceWith({ domainId });
    h.activatePending = true;
    const pending = button(render(), copy().receivingActivating);
    expect(pending.props.disabled).toBe(true);
    expect(pending.props["aria-busy"]).toBe(true);
    if (!finish) throw new Error("Mutation was not started");
    finish(readyResult());
    await vi.waitFor(() => expect(h.setQueryData).toHaveBeenCalledOnce());
  });
  it("uses server readback to confirm this mailbox and prevent repeated activation", async () => {
    click(button(render(), copy().activateReceiving));
    await vi.waitFor(() => expect(h.setQueryData).toHaveBeenCalledOnce());
    const tree = render();
    expect(text(tree)).toContain(copy().activationReady);
    expect(button(tree, copy().activateReceiving).props.disabled).toBe(true);
    expect(
      nodes(tree).some(
        (node) => node.props.role === "status" && text(node) === copy().activationReady,
      ),
    ).toBe(true);
  });
  it("does not claim this mailbox activated when only the domain is ready", async () => {
    h.activate.mockResolvedValue({ ...h.receiving, state: "ready" });
    click(button(render(), copy().activateReceiving));
    await vi.waitFor(() => expect(h.setQueryData).toHaveBeenCalledOnce());
    expect(text(render())).toContain(copy().activationPending);
    expect(text(render())).not.toContain(copy().activationReady);
  });
  it("preserves the reservation on an uncertain failure and describes it safely", async () => {
    h.activate.mockRejectedValue(new Error("private-provider-identifier"));
    click(button(render(), copy().activateReceiving));
    await vi.waitFor(() => expect(h.refetch).toHaveBeenCalledOnce());
    const tree = render();
    expect(text(tree)).toContain(copy().activationError);
    expect(text(tree)).toContain("luna@fixture.example.invalid");
    expect(text(tree)).not.toContain("private-provider-identifier");
    expect(
      nodes(tree).some(
        (node) => node.props.role === "alert" && text(node) === copy().activationError,
      ),
    ).toBe(true);
  });
});
