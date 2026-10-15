import { observable } from "@trpc/server/observable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEloziSupportSession, type SupportIdentity } from "@/lib/elozi-support";
import {
  announceOnAuthTransitionRequest,
  announceOnAuthTransitionSettled,
  announceOnSignOutRequest,
  announceSupportSessionChange,
  isSignOutRequest,
  onSupportSessionChange,
  supportSessionLink,
} from "@/lib/support-session-signal";

/**
 * The support chat's lifecycle across windows: a sign-out or team switch in the
 * dashboard ends the chat's capability in its window (/support/chat) at once, even
 * with the chat panel closed, and late identity callbacks of the old account fail.
 * Synthetic fixtures only: a fake window, the SaaS widget as a recorder.
 */

/** A minimal window for node: events, localStorage, and the storage event of other windows. */
function fakeWindow() {
  const target = new EventTarget();
  const store = new Map<string, string>();
  return Object.assign(target, {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.stubGlobal("window", fakeWindow());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Support session signal", () => {
  it("reaches the other windows through the BroadcastChannel, once per signal", async () => {
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    announceSupportSessionChange("signed-out");
    announceSupportSessionChange("account-changed");
    await tick();
    expect(heard).toEqual(["signed-out", "account-changed"]);
    stop();
    announceSupportSessionChange("signed-out");
    await tick();
    expect(heard).toHaveLength(2);
  });

  it("falls back to the storage event without BroadcastChannel, and never handles one signal twice", async () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("unsupported");
        }
      },
    );
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    announceSupportSessionChange("account-changed");
    const value = window.localStorage.getItem("mepmail.support-session");
    expect(value).toBeTruthy();
    // What another window receives when this one writes the key (twice: dedupe).
    for (let i = 0; i < 2; i++) {
      const event = Object.assign(new Event("storage"), {
        key: "mepmail.support-session",
        newValue: value,
      });
      window.dispatchEvent(event);
    }
    expect(heard).toEqual(["account-changed"]);
    stop();
  });

  it("announces a sign-out as its request leaves, and nothing for other auth calls", async () => {
    expect(isSignOutRequest("/api/auth/sign-out")).toBe(true);
    expect(isSignOutRequest(new URL("https://mepmail.dev/api/auth/sign-out"))).toBe(true);
    expect(isSignOutRequest("/api/auth/sign-in/email")).toBe(false);
    expect(isSignOutRequest("/api/auth/get-session")).toBe(false);
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    announceOnSignOutRequest({ url: "/api/auth/get-session" });
    announceOnSignOutRequest({ url: "https://mepmail.dev/api/auth/sign-out" });
    await tick();
    expect(heard).toEqual(["signed-out"]);
    stop();
  });

  it("invalidates before and after team switch, creation and invitation, including failures", async () => {
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    const run = (path: string, type: "mutation" | "query", fail = false) =>
      new Promise<void>((resolve) => {
        const link = supportSessionLink({} as never);
        link({
          op: { path, type, id: 1, input: {}, context: {}, signal: null } as never,
          next: () =>
            observable((observer) => {
              if (fail) observer.error(new Error("refused") as never);
              else {
                observer.next({ result: { type: "data", data: null } } as never);
                observer.complete();
              }
            }),
        }).subscribe({ complete: () => resolve(), error: () => resolve() });
      });
    await run("team.switch", "query");
    await run("team.switch", "mutation", true);
    await run("mailboxes.setStar", "mutation");
    await tick();
    expect(heard).toEqual(["account-changed", "account-changed"]);
    await run("team.switch", "mutation");
    await run("team.createTeam", "mutation");
    await run("settings.invitations.accept", "mutation");
    await tick();
    expect(heard).toEqual(Array(8).fill("account-changed"));
    stop();
  });
});

describe("Support auth transition hook", () => {
  it("invalidates immediately at login/logout intent and completion, without sending identity data", () => {
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-in/email" });
    announceOnAuthTransitionSettled({ request: { url: "/api/auth/sign-in/email" } });
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-out" });
    announceOnAuthTransitionSettled({ request: { url: "/api/auth/sign-out" } });
    expect(heard).toEqual(["account-changed", "account-changed", "signed-out", "signed-out"]);
    const signal = JSON.parse(window.localStorage.getItem("mepmail.support-session")!);
    expect(Object.keys(signal).sort()).toEqual(["id", "kind"]);
    stop();
  });
});

describe("Support chat lifecycle: logout and team switch from another window", () => {
  const A: SupportIdentity = { accountId: "team_a", userId: "user_1" };
  const B: SupportIdentity = { accountId: "team_b", userId: "user_1" };

  /** The Elozi SaaS manager as a recorder of what the MepMail session asks of it. */
  function saas() {
    const widget = {
      open: vi.fn(async () => undefined),
      destroy: vi.fn(),
      setAccount: vi.fn((_identity: SupportIdentity | null) => true),
    };
    let getToken: ((expected: SupportIdentity) => Promise<string>) | null = null;
    const module = {
      createSaasWebchat: vi.fn(
        (options: { getIdentityToken: (expected: SupportIdentity) => Promise<string> }) => {
          getToken = options.getIdentityToken;
          return widget;
        },
      ),
    };
    return { widget, module, token: (expected: SupportIdentity) => getToken!(expected) };
  }
  const config = { tenantId: "fixture_tenant", channelId: "fixture_channel" };

  it("an event during initial identity resolution drops the late response without mounting another account", async () => {
    const { module } = saas();
    let release!: (value: { token: string; identity: SupportIdentity }) => void;
    const provider = vi.fn(
      () =>
        new Promise<{ token: string; identity: SupportIdentity }>((resolve) => {
          release = resolve;
        }),
    );
    const session = createEloziSupportSession(config, vi.fn(), async () => module, provider);
    const stop = onSupportSessionChange((kind) => session.invalidate(kind));
    const opening = session.open();
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-in/email" });
    release({ token: "late.old.token", identity: A });
    expect(await opening).toBe(false);
    expect(module.createSaasWebchat).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    stop();
    session.destroy();
  });

  it("a sign-out heard with the panel closed ends the capability at once and refuses late callbacks", async () => {
    const { widget, module, token } = saas();
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    expect(await session.open()).toBe(true);
    expect(await token(A)).toBe("tok.a");
    provider.mockClear();

    // The person closed the chat panel and signed out in the dashboard.
    session.invalidate("signed-out");
    expect(widget.setAccount).toHaveBeenLastCalledWith(null);
    expect(status).toHaveBeenLastCalledWith("error");
    // A callback the widget makes afterwards for account A fails without a request.
    await expect(token(A)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it("drops a token that arrives after the sign-out (request in flight)", async () => {
    const { module, token } = saas();
    let release: (value: { token: string; identity: SupportIdentity }) => void = () => undefined;
    const provider = vi.fn(async (expected?: SupportIdentity) =>
      expected
        ? new Promise<{ token: string; identity: SupportIdentity }>((resolve) => {
            release = resolve;
          })
        : { token: "tok.a", identity: A },
    );
    const session = createEloziSupportSession(config, vi.fn(), async () => module, provider);
    await session.open();
    const late = token(A);
    session.invalidate("signed-out");
    release({ token: "tok.a.late", identity: A });
    await expect(late).rejects.toThrow();
  });

  it("a team switch with a pending identity request drops the old answer and moves to the new account", async () => {
    const { widget, module, token } = saas();
    const answers: Array<(value: { token: string; identity: SupportIdentity }) => void> = [];
    const provider = vi.fn(async (_expected?: SupportIdentity) =>
      answers.length === 0 && provider.mock.calls.length === 1
        ? { token: "tok.a", identity: A }
        : new Promise<{ token: string; identity: SupportIdentity }>((resolve) =>
            answers.push(resolve),
          ),
    );
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    await session.open();
    widget.setAccount.mockClear();

    // A focus reconcile is in flight when the dashboard switches to team B.
    const stale = session.reconcile();
    session.invalidate("account-changed");
    expect(widget.setAccount).toHaveBeenLastCalledWith(null);
    expect(status).toHaveBeenLastCalledWith("error");
    answers.shift()!({ token: "tok.a", identity: A });
    expect(await stale).toBe(false);
    expect(widget.setAccount).not.toHaveBeenCalledWith(A);

    // The window is visible: it reconciles and holds team B from now on.
    const fresh = session.reconcile();
    answers.shift()!({ token: "tok.b", identity: B });
    expect(await fresh).toBe(true);
    expect(widget.setAccount).toHaveBeenLastCalledWith(B);
    expect(status).toHaveBeenLastCalledWith("opened");
    // Team A's callbacks are refused; team B's go through.
    await expect(token(A)).rejects.toThrow();
    const asked = token(B);
    answers.shift()!({ token: "tok.b2", identity: B });
    expect(await asked).toBe("tok.b2");
  });

  it("a revoked association closes the identified chat instead of falling back to a visitor", async () => {
    const { widget, module } = saas();
    const provider = vi
      .fn(async (_expected?: SupportIdentity) => ({ token: "tok.a", identity: A }))
      .mockResolvedValueOnce({ token: "tok.a", identity: A })
      .mockRejectedValueOnce(new Error("403"));
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    await session.open();
    expect(await session.reconcile()).toBe(false);
    expect(widget.setAccount).toHaveBeenLastCalledWith(null);
    expect(status).toHaveBeenLastCalledWith("error");
    expect(module.createSaasWebchat).toHaveBeenCalledTimes(1);
  });

  it("a team switch while the first opening waits for the identity resumes on the new account", async () => {
    const { widget, module } = saas();
    let releaseFirst: (value: { token: string; identity: SupportIdentity }) => void = () =>
      undefined;
    let calls = 0;
    const provider = vi.fn(async (_expected?: SupportIdentity) => {
      calls += 1;
      if (calls === 1)
        return new Promise<{ token: string; identity: SupportIdentity }>((resolve) => {
          releaseFirst = resolve;
        });
      return { token: "tok.b", identity: B };
    });
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    const first = session.open();
    expect(status).toHaveBeenLastCalledWith("loading");
    // The dashboard switches to team B while A's identity is still on its way.
    session.invalidate("account-changed");
    releaseFirst({ token: "tok.a", identity: A });
    expect(await first).toBe(false);
    expect(module.createSaasWebchat).not.toHaveBeenCalled();
    // The visible window reconciles: it opens for B instead of loading forever.
    expect(await session.reconcile()).toBe(true);
    expect(module.createSaasWebchat).toHaveBeenCalledTimes(1);
    expect(module.createSaasWebchat.mock.calls[0]?.[0]).toMatchObject({ identity: B });
    expect(widget.open).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("opened");
  });

  it("a team switch while the widget import is pending resumes on the new account", async () => {
    const { module } = saas();
    let account = A;
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: `tok.${account.accountId}`,
      identity: account,
    }));
    let releaseImport: (value: typeof module) => void = () => undefined;
    let imports = 0;
    const load = vi.fn(async () => {
      imports += 1;
      if (imports === 1)
        return new Promise<typeof module>((resolve) => {
          releaseImport = resolve;
        });
      return module;
    });
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, load as never, provider);
    const first = session.open();
    await Promise.resolve();
    await Promise.resolve();
    account = B;
    session.invalidate("account-changed");
    releaseImport(module);
    expect(await first).toBe(false);
    expect(module.createSaasWebchat).not.toHaveBeenCalled();
    expect(await session.reconcile()).toBe(true);
    expect(module.createSaasWebchat).toHaveBeenCalledTimes(1);
    expect(module.createSaasWebchat.mock.calls[0]?.[0]).toMatchObject({ identity: B });
    expect(status).toHaveBeenLastCalledWith("opened");
  });

  it("a sign-out whose answer is late, then focus on the popup: the capability stays ended", async () => {
    const { widget, module } = saas();
    // The server has not processed the sign-out yet: it would still answer for A.
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    await session.open();
    widget.setAccount.mockClear();
    widget.open.mockClear();
    provider.mockClear();

    session.invalidate("signed-out");
    // Focus and visibility on the popup reconcile; nothing reopens and nothing is asked.
    expect(await session.reconcile()).toBe(false);
    expect(await session.reconcile()).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(widget.setAccount).toHaveBeenCalledTimes(1);
    expect(widget.setAccount).toHaveBeenLastCalledWith(null);
    expect(widget.open).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("error");

    // Only the person opening it again asks the server, which decides (401 once out).
    provider.mockRejectedValueOnce(new Error("401"));
    expect(await session.open()).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(widget.open).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("error");
  });

  it("does nothing for the visitor chat (no identity to end)", async () => {
    const widget = { open: vi.fn(), destroy: vi.fn() };
    const module = { createWebchatWidget: vi.fn(() => widget) };
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module);
    await session.open();
    status.mockClear();
    session.invalidate("signed-out");
    expect(status).not.toHaveBeenCalled();
    expect(widget.destroy).not.toHaveBeenCalled();
  });
});

describe("Support chat lifecycle through the real signal (revoke only)", () => {
  const A: SupportIdentity = { accountId: "team_a", userId: "user_1" };
  const B: SupportIdentity = { accountId: "team_b", userId: "user_1" };
  const config = { tenantId: "fixture_tenant", channelId: "fixture_channel" };
  function saas() {
    const widget = {
      open: vi.fn(async () => undefined),
      destroy: vi.fn(),
      setAccount: vi.fn((_identity: SupportIdentity | null) => true),
    };
    const module = { createSaasWebchat: vi.fn((_options: Record<string, unknown>) => widget) };
    return { widget, module };
  }
  /** A chat window wired like elozi-support.tsx / support-chat-window.tsx. */
  async function chatWindow(
    provider: (expected?: SupportIdentity) => Promise<{ token: string; identity: SupportIdentity }>,
  ) {
    const { widget, module } = saas();
    const status = vi.fn();
    const session = createEloziSupportSession(config, status, async () => module, provider);
    const stop = onSupportSessionChange((kind) => session.invalidate(kind));
    return { widget, module, status, session, stop };
  }

  it("a hidden popup revokes on the local event synchronously, with no focus and no identity request", async () => {
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const chat = await chatWindow(provider);
    await chat.session.open();
    provider.mockClear();
    chat.widget.setAccount.mockClear();
    announceSupportSessionChange("signed-out");
    // Synchronous: revoked before any await, with no focus or visibility event.
    expect(chat.widget.setAccount).toHaveBeenCalledWith(null);
    expect(chat.status).toHaveBeenLastCalledWith("error");
    await tick();
    expect(provider).not.toHaveBeenCalled();
    expect(chat.module.createSaasWebchat).toHaveBeenCalledTimes(1);
    chat.stop();
    chat.session.destroy();
  });

  it("a hidden popup also revokes on a signal from another window (BroadcastChannel)", async () => {
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const chat = await chatWindow(provider);
    await chat.session.open();
    chat.widget.setAccount.mockClear();
    const other = new BroadcastChannel("mepmail-support-session");
    other.postMessage({ kind: "account-changed", id: "other-window-1" });
    other.close();
    await tick();
    expect(chat.widget.setAccount).toHaveBeenCalledWith(null);
    expect(chat.status).toHaveBeenLastCalledWith("error");
    chat.stop();
    chat.session.destroy();
  });

  it("login and logout revoke; after a sign-out a sign-in signal does not reopen the chat", async () => {
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const chat = await chatWindow(provider);
    await chat.session.open();
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-out" });
    announceOnAuthTransitionSettled({ request: { url: "/api/auth/sign-out" } });
    // Someone signs in again in the dashboard: still closed, nothing asked or mounted.
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-in/email" });
    announceOnAuthTransitionSettled({ request: { url: "/api/auth/sign-in/email" } });
    provider.mockClear();
    expect(await chat.session.reconcile()).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(chat.module.createSaasWebchat).toHaveBeenCalledTimes(1);
    chat.stop();
    chat.session.destroy();
  });

  it("focus during a pending sign-out keeps the capability ended, and its completion revokes again", async () => {
    // The server still answers for A while the sign-out request is on its way.
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const chat = await chatWindow(provider);
    await chat.session.open();
    announceOnAuthTransitionRequest({ url: "/api/auth/sign-out" });
    provider.mockClear();
    chat.widget.open.mockClear();
    expect(await chat.session.reconcile()).toBe(false); // focus on the popup
    expect(provider).not.toHaveBeenCalled();
    expect(chat.widget.open).not.toHaveBeenCalled();
    announceOnAuthTransitionSettled({ request: { url: "/api/auth/sign-out" } });
    expect(await chat.session.reconcile()).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    chat.stop();
    chat.session.destroy();
  });

  it("a team switch during the identity resolution: the signal only revokes, focus resumes on B", async () => {
    let account = A;
    let release: () => void = () => undefined;
    let first = true;
    const provider = vi.fn(async (_expected?: SupportIdentity) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { token: "tok.a", identity: A };
      }
      return { token: `tok.${account.accountId}`, identity: account };
    });
    const chat = await chatWindow(provider);
    const opening = chat.session.open();
    // The dashboard starts switching to B (the tRPC link announces at the start).
    account = B;
    announceSupportSessionChange("account-changed");
    expect(provider).toHaveBeenCalledTimes(1); // the signal asked nothing
    release();
    expect(await opening).toBe(false);
    expect(chat.module.createSaasWebchat).not.toHaveBeenCalled();
    expect(chat.status).toHaveBeenLastCalledWith("error");
    // Focus/visibility reconciles through the verified endpoint: B, not loading forever.
    expect(await chat.session.reconcile()).toBe(true);
    expect(chat.module.createSaasWebchat.mock.calls[0]?.[0]).toMatchObject({ identity: B });
    expect(chat.status).toHaveBeenLastCalledWith("opened");
    chat.stop();
    chat.session.destroy();
  });

  it("a mutation cancelled while pending ends its transport, revokes, and its late answer reaches nobody", async () => {
    const heard: string[] = [];
    const stop = onSupportSessionChange((kind) => heard.push(kind));
    const provider = vi.fn(async (_expected?: SupportIdentity) => ({
      token: "tok.a",
      identity: A,
    }));
    const chat = await chatWindow(provider);
    await chat.session.open();
    provider.mockClear();
    let transportOpen = false;
    const late: { emit?: () => void } = {};
    const received: unknown[] = [];
    const link = supportSessionLink({} as never);
    const subscription = link({
      op: {
        path: "team.switch",
        type: "mutation",
        id: 7,
        input: {},
        context: {},
        signal: null,
      } as never,
      next: () =>
        observable((observer) => {
          transportOpen = true;
          late.emit = () => {
            observer.next({ result: { type: "data", data: { teamId: "team_b" } } } as never);
            observer.complete();
          };
          return () => {
            transportOpen = false;
          };
        }),
    }).subscribe({ next: (value) => received.push(value) });
    expect(transportOpen).toBe(true);
    expect(heard).toEqual(["account-changed"]); // revoked at the start
    subscription.unsubscribe();
    expect(transportOpen).toBe(false); // the transport ended with the subscription
    expect(heard).toEqual(["account-changed", "account-changed"]); // revoked on cancel
    late.emit?.();
    await tick();
    expect(received).toEqual([]);
    expect(heard).toHaveLength(2);
    // Nothing remounted or authorized the chat: no identity asked, one widget, revoked.
    expect(provider).not.toHaveBeenCalled();
    expect(chat.module.createSaasWebchat).toHaveBeenCalledTimes(1);
    expect(chat.widget.setAccount).toHaveBeenLastCalledWith(null);
    stop();
    chat.stop();
    chat.session.destroy();
  });
});
