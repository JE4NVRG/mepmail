import { afterEach, describe, expect, it, vi } from "vitest";

let key: Buffer | null = Buffer.alloc(32);
vi.mock("@/server/mailbox-app-password-key", () => ({ mailboxAppPasswordKey: () => key }));
vi.mock("@/server/mailboxes", () => ({ mailboxActorAccessEnabled: async () => true }));

const { mailboxClientAccessOpen } = await import("@/server/routers/mailbox-clients");

afterEach(() => {
  vi.unstubAllEnvs();
  key = Buffer.alloc(32);
});

describe("Usar em outro app de e-mail: who sees it", () => {
  it("only the pilot teams before it opens, everyone after, nobody without a master key", () => {
    vi.stubEnv("MAILBOX_CLIENT_ACCESS_OPEN", "");
    vi.stubEnv("MAILBOX_CLIENT_ACCESS_TEAM_IDS", " team-a , team-b");
    expect(mailboxClientAccessOpen("team-a")).toBe(true);
    expect(mailboxClientAccessOpen("team-b")).toBe(true);
    expect(mailboxClientAccessOpen("team-c")).toBe(false);
    vi.stubEnv("MAILBOX_CLIENT_ACCESS_TEAM_IDS", "");
    expect(mailboxClientAccessOpen("team-a")).toBe(false);
    expect(mailboxClientAccessOpen("")).toBe(false);
    vi.stubEnv("MAILBOX_CLIENT_ACCESS_OPEN", "1");
    expect(mailboxClientAccessOpen("team-c")).toBe(true);
    key = null;
    expect(mailboxClientAccessOpen("team-c")).toBe(false);
  });
});
