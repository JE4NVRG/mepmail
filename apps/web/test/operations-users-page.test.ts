import { beforeEach, describe, expect, it, vi } from "vitest";
import OperationsUsersPage from "../src/app/(dashboard)/operations/users/page";

const fixture = vi.hoisted(() => ({
  headers: new Headers({ "x-synthetic": "directory" }),
  reader: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("synthetic-not-found");
  }),
}));
vi.mock("next/headers", () => ({ headers: async () => fixture.headers }));
vi.mock("next/navigation", () => ({ notFound: fixture.notFound }));
vi.mock("@/server/users-directory-gate", () => ({ usersDirectoryReader: fixture.reader }));
vi.mock("@/components/console/users/users-view", () => ({ UsersView: () => null }));

beforeEach(() => vi.clearAllMocks());

describe("operational directory page admission", () => {
  it("checks request headers and renders only the read-only view for an authorized reader", async () => {
    fixture.reader.mockResolvedValue({ id: "synthetic-reader", email: "reader@synthetic.invalid" });
    const page = await OperationsUsersPage();
    expect(fixture.reader).toHaveBeenCalledExactlyOnceWith(fixture.headers);
    expect(page.props.readOnly).toBe(true);
    expect(fixture.notFound).not.toHaveBeenCalled();
  });

  it("returns not found without rendering the directory when permission is absent", async () => {
    fixture.reader.mockResolvedValue(null);
    await expect(OperationsUsersPage()).rejects.toThrow("synthetic-not-found");
    expect(fixture.notFound).toHaveBeenCalledOnce();
  });
});
