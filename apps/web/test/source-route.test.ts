import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
const { readFile } = await import("node:fs/promises");
const { GET } = await import("@/app/source/route");

describe("corresponding source download", () => {
  it("serves the packaged bytes without redirecting to a different revision", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("source archive"));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/gzip");
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("source archive");
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/source\.tar\.gz$/));
  });
  it("fails closed when the corresponding archive is missing", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    expect((await GET()).status).toBe(503);
  });
});
