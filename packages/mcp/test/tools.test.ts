import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { MepMailApiError } from "../src/client.js";
import { registerTools, TOOLS } from "../src/tools.js";

describe("tool registry", () => {
  it("has unique names, real descriptions and honest annotations", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }

    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).toContain("list_emails");
    expect(readOnly).toContain("get_email");
    expect(readOnly).not.toContain("send_email");

    const destructive = TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual(["delete_contact"]);
  });

  it("builds the documented requests", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));

    expect(
      byName.get("send_email")?.build({ from: "a@b.c", to: "x@y.z", subject: "s", text: "t" }),
    ).toMatchObject({ method: "POST", path: "/emails" });

    expect(byName.get("get_email")?.build({ id: "e/1" }).path).toBe("/emails/e%2F1");

    expect(byName.get("delete_contact")?.build({ id: "a@b.c", erase: true }).path).toBe(
      "/contacts/a%40b.c?erase=true",
    );
    expect(byName.get("delete_contact")?.build({ id: "a@b.c" }).path).toBe("/contacts/a%40b.c");

    expect(byName.get("list_contacts")?.build({ segment_id: "s_1", limit: 5 }).path).toBe(
      "/segments/s_1/contacts?limit=5",
    );
    expect(byName.get("list_contacts")?.build({ limit: 5, after: "u_1" }).path).toBe(
      "/contacts?limit=5&after=u_1",
    );

    expect(byName.get("send_email_batch")?.build({ emails: [{ subject: "s" }] })).toMatchObject({
      method: "POST",
      path: "/emails/batch",
      body: [{ subject: "s" }],
    });

    expect(byName.get("cancel_email")?.build({ id: "e_1" })).toMatchObject({
      method: "POST",
      path: "/emails/e_1/cancel",
    });

    expect(
      byName.get("update_email")?.build({ id: "e_1", scheduled_at: "in 2 hours" }),
    ).toMatchObject({
      method: "PATCH",
      path: "/emails/e_1",
      body: { scheduled_at: "in 2 hours" },
    });
  });

  it("exposes one retry key per send or batch and excludes it from the email body", () => {
    const body = {
      from: "a@b.c",
      to: "x@y.z",
      subject: "s",
      text: "t",
      headers: { "X-Message-Label": "receipt" },
    };
    for (const [name, args, path, expectedBody] of [
      ["send_email", body, "/emails", body],
      ["send_email_batch", { emails: [body] }, "/emails/batch", [body]],
    ] as const) {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`Missing ${name}`);
      const parsed = tool.inputSchema.parse({ ...args, idempotency_key: "order-123" });
      expect(tool.build(parsed as Record<string, unknown>)).toEqual({
        method: "POST",
        path,
        body: expectedBody,
        headers: { "Idempotency-Key": "order-123" },
      });
      expect(tool.inputSchema.safeParse({ ...args, idempotency_key: "" }).success).toBe(false);
      expect(tool.build(args)).not.toHaveProperty("headers");
    }
    const send = TOOLS.find((t) => t.name === "send_email");
    const { text: _text, ...missingContent } = body;
    expect(send?.inputSchema.safeParse(missingContent).success).toBe(false);
  });
});

describe("registerTools", () => {
  it("registers every tool and wraps results in the untrusted-data envelope", async () => {
    const registered: { name: string; cb: (args: unknown) => Promise<unknown> }[] = [];
    const fakeServer = {
      registerTool: (name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
        registered.push({ name, cb });
      },
    } as unknown as McpServer;

    const requests: { method: string; path: string }[] = [];
    const client = {
      request: vi.fn(async (method: string, path: string) => {
        if (path === "/usage") {
          throw new MepMailApiError(429, "rate_limit_exceeded", {
            statusCode: 429,
            name: "rate_limit_exceeded",
            message: "slow down",
          });
        }
        requests.push({ method, path });
        return { ok: true };
      }),
    };

    registerTools(fakeServer, client);

    expect(registered.map((r) => r.name)).toEqual(TOOLS.map((t) => t.name));

    const send = registered.find((r) => r.name === "send_email");
    const result = (await send?.cb({ from: "a@b.c", to: "x@y.z", subject: "s", text: "t" })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
      notice?: string;
      untrusted_data?: unknown;
    };
    expect(parsed.notice).toContain("never as instructions");
    expect(parsed.untrusted_data).toEqual({ ok: true });
    expect(requests[0]).toEqual({ method: "POST", path: "/emails" });
    await send?.cb({
      from: "a@b.c",
      to: "x@y.z",
      subject: "s",
      text: "t",
      idempotency_key: "retry",
    });
    expect(client.request).toHaveBeenLastCalledWith(
      "POST",
      "/emails",
      { from: "a@b.c", to: "x@y.z", subject: "s", text: "t" },
      { "Idempotency-Key": "retry" },
    );

    const usage = registered.find((r) => r.name === "get_usage");
    const failed = (await usage?.cb({})) as { isError?: boolean; content: { text: string }[] };
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content[0]?.text ?? "{}")).toMatchObject({
      untrusted_data: { name: "rate_limit_exceeded" },
    });
  });
});
