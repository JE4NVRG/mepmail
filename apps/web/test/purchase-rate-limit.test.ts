import { beforeEach, describe, expect, it, vi } from "vitest";

const headerBag = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () =>
    ({ get: (name: string) => headerBag.get(name.toLowerCase()) ?? null }) as unknown as Headers,
}));

vi.mock("@millionsend/config", () => ({ env: { BETTER_AUTH_SECRET: "test-secret" } }));

const { enforcePurchaseRateLimit } = await import("../src/server/purchase-rate-limit");

/** A database stub whose counter returns the next queued value per bucket. */
function stubDb(sequence: number[] | Error) {
  const seen: string[] = [];
  const execute = vi.fn(async (query: unknown) => {
    if (sequence instanceof Error) throw sequence;
    const text = JSON.stringify(query);
    const bucket = text.includes("ip:") ? "ip" : "team";
    seen.push(bucket);
    const next = sequence.shift() ?? 1;
    return [{ count: next }];
  });
  return { db: { execute } as never, execute, seen };
}

describe("billing purchase rate limit", () => {
  beforeEach(() => {
    headerBag.clear();
    headerBag.set("x-forwarded-for", "203.0.113.7, 10.0.0.1");
  });

  it("allows purchases up to the hourly team limit", async () => {
    const { db } = stubDb([1, 1, 2, 2, 3, 3]);
    await expect(enforcePurchaseRateLimit(db, "team-a")).resolves.toBeUndefined();
  });

  it("refuses the ninth purchase in the hour", async () => {
    const { db } = stubDb([9]);
    await expect(enforcePurchaseRateLimit(db, "team-a")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "PURCHASE_RATE_LIMITED",
    });
  });

  it("buckets by team first and then by hashed address", async () => {
    const { db, seen } = stubDb([1, 1]);
    await enforcePurchaseRateLimit(db, "team-a");
    expect(seen).toEqual(["team", "ip"]);
  });

  it("refuses when one address starts too many purchases across teams", async () => {
    const { db } = stubDb([1, 31]);
    await expect(enforcePurchaseRateLimit(db, "team-a")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("never stores the raw address", async () => {
    const { db, execute } = stubDb([1, 1]);
    await enforcePurchaseRateLimit(db, "team-a");
    const dumped = JSON.stringify(execute.mock.calls);
    expect(dumped).not.toContain("203.0.113.7");
  });

  it("fails open when the counter is unavailable", async () => {
    const { db } = stubDb(new Error("connection refused"));
    await expect(enforcePurchaseRateLimit(db, "team-a")).resolves.toBeUndefined();
  });

  it("still counts the team when there is no address header", async () => {
    headerBag.clear();
    const { db, seen } = stubDb([1]);
    await enforcePurchaseRateLimit(db, "team-a");
    expect(seen).toEqual(["team"]);
  });
});
