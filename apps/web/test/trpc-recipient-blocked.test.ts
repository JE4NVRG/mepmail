import { MailboxRecipientBlockedError } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (url: string) => url }));

const { publicProcedure, router } = await import("@/server/trpc");

// The Correio screens read this over HTTP: a send refused for recipients that bounced or
// complained answers FORBIDDEN with message "recipient_blocked" and names them in data.
const app = router({
  blocked: publicProcedure.mutation(() => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "recipient_blocked",
      cause: new MailboxRecipientBlockedError(["blocked@example.invalid"]),
    });
  }),
  other: publicProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN" });
  }),
});

async function post(path: string) {
  const res = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://localhost/api/trpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: null }),
    }),
    router: app,
    createContext: () => ({}) as never,
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      error: { json: { message?: string; data?: Record<string, unknown> } };
    },
  };
}

describe("recipient_blocked over tRPC", () => {
  it("carries the blocked recipients in the error data", async () => {
    const { status, body } = await post("blocked");
    expect(status).toBe(403);
    expect(body.error.json).toMatchObject({
      message: "recipient_blocked",
      data: { code: "FORBIDDEN", blockedRecipients: ["blocked@example.invalid"] },
    });
  });

  it("leaves every other error's shape alone", async () => {
    const { body } = await post("other");
    expect(body.error.json.data).not.toHaveProperty("blockedRecipients");
  });
});
