import { describe, expect, it, vi } from "vitest";
import { createPublicStatusReader, STATUS_CHECK_TTL_MS } from "../src/lib/public-status";

describe("public status availability", () => {
  it("deduplicates concurrent readers and caches the timestamp, without account credentials", async () => {
    let time = 1_800_000_000_000;
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(options?.credentials).toBe("omit");
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toBeUndefined();
      return new Response("public", { status: 200 });
    });
    const read = createPublicStatusReader(request, () => time);
    const [first, parallel] = await Promise.all([read(), read()]);
    expect(parallel).toEqual(first);
    expect(first.checks.every((check) => check.available)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    time += STATUS_CHECK_TTL_MS - 1;
    expect(await read()).toBe(first);
    expect(request).toHaveBeenCalledTimes(3);
    time += 1;
    expect((await read()).checkedAt).not.toBe(first.checkedAt);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("does not report success for HTTP failures or network errors, and never exposes error contents", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await createPublicStatusReader(request)();
    expect(result.checks).toEqual([
      { id: "web", available: false, httpStatus: 503 },
      { id: "api", available: false, httpStatus: null },
      { id: "docs", available: true, httpStatus: 200 },
    ]);
    expect(JSON.stringify(result)).not.toContain("private detail");
  });
});
