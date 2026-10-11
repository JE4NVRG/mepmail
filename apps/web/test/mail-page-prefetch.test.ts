import { beforeEach, describe, expect, it, vi } from "vitest";

// The page's server prefetch with its collaborators replaced: what matters here is
// that nothing it calls can take the Correio page down.
const createContext = vi.fn();
const mailboxActorAccessEnabled = vi.fn();
vi.mock("../src/server/trpc", () => ({ createContext }));
vi.mock("../src/server/mailboxes", () => ({ mailboxActorAccessEnabled }));
vi.mock("../src/server/routers", () => ({ appRouter: {} }));

const { prefetchMailPage } = await import("../src/server/mail-page-prefetch");
const session = { user: { id: "u1" } };

describe("prefetchMailPage", () => {
  beforeEach(() => {
    createContext.mockReset();
    mailboxActorAccessEnabled.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("resolves null when the context cannot be built (a stale support-view cookie)", async () => {
    createContext.mockRejectedValue(
      new Error("Cookies can only be modified in a Server Action or Route Handler"),
    );
    await expect(prefetchMailPage(new Headers())).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("resolves null when the access check throws", async () => {
    createContext.mockResolvedValue({ db: {}, session, teamId: "t1" });
    mailboxActorAccessEnabled.mockRejectedValue(new Error("db down"));
    await expect(prefetchMailPage(new Headers())).resolves.toBeNull();
  });

  it("reads nothing without a session or team, in a support view, or without access", async () => {
    for (const ctx of [
      { db: {}, session: null, teamId: null },
      { db: {}, session, teamId: null },
      { db: {}, session, teamId: "t1", supportView: { grantId: "g" } },
    ]) {
      createContext.mockResolvedValueOnce(ctx);
      await expect(prefetchMailPage(new Headers())).resolves.toBeNull();
    }
    expect(mailboxActorAccessEnabled).not.toHaveBeenCalled();
    createContext.mockResolvedValueOnce({ db: {}, session, teamId: "t1" });
    mailboxActorAccessEnabled.mockResolvedValueOnce(false);
    await expect(prefetchMailPage(new Headers())).resolves.toBeNull();
  });
});
