import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
const { readFile } = await import("node:fs/promises");
const { GET } = await import("@/app/source/route");

const REVISION = "80ed8416ecc4bf549dd14af4aff3a0cf3753a47a";

/** The pipeline packs the archive and its revision side by side. */
function packaged(revision: string) {
  vi.mocked(readFile).mockImplementation((async (path: unknown) =>
    String(path).endsWith("SOURCE-REVISION")
      ? `${revision}\n`
      : Buffer.from("source archive")) as unknown as typeof readFile);
}

describe("corresponding source download", () => {
  it("serves the packaged bytes without redirecting to a different revision", async () => {
    packaged(REVISION);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/gzip");
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("X-MepMail-Revision")).toBe(REVISION);
    expect(response.headers.get("Content-Disposition")).toContain(
      `mepmail-source-${REVISION.slice(0, 12)}.tar.gz`,
    );
    expect(await response.text()).toBe("source archive");
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/source\.tar\.gz$/));
  });
  it("fails closed when the corresponding archive is missing", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    expect((await GET()).status).toBe(503);
  });
  it("fails closed when the packaged revision is not a full commit id", async () => {
    packaged("main");
    expect((await GET()).status).toBe(503);
  });
});
