import { describe, expect, it } from "vitest";
import {
  base64Bytes,
  carryForwardSelection,
  clipboardAttachments,
  composerCanCarry,
  composerFileProblem,
  pastedFileName,
} from "../src/lib/mailbox-composer-attachments";

describe("mailbox composer attachments", () => {
  it("computes decoded base64 byte sizes accurately", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes(Buffer.from("hi").toString("base64"))).toBe(2);
    expect(base64Bytes(Buffer.from("hey").toString("base64"))).toBe(3);
  });

  it("allows files up to 10 MiB each and 16 MiB total within the allowlist", () => {
    const nineMb = 9 * 1024 * 1024;
    expect(
      composerFileProblem({ count: 0, bytes: 0 }, [{ name: "doc.pdf", size: nineMb }]),
    ).toBeNull();
    expect(
      composerFileProblem({ count: 1, bytes: nineMb }, [{ name: "photo.png", size: nineMb }]),
    ).toBe("size");
    expect(
      composerFileProblem({ count: 0, bytes: 0 }, [
        { name: "huge.pdf", size: 10 * 1024 * 1024 + 1 },
      ]),
    ).toBe("size");
    expect(composerFileProblem({ count: 0, bytes: 0 }, [{ name: "run.exe", size: 512 }])).toBe(
      "type",
    );
    expect(composerFileProblem({ count: 10, bytes: 0 }, [{ name: "a.txt", size: 10 }])).toBe(
      "count",
    );
  });

  it("filters forwarded/draft attachments by 10 MiB, 16 MiB total, and allowlist", () => {
    expect(composerCanCarry({ bytes: 5 * 1024 * 1024, filename: "contract.pdf" })).toBe(true);
    expect(composerCanCarry({ bytes: 1024, filename: "payload.exe" })).toBe(false);

    const split = carryForwardSelection([
      { index: 0, filename: "first.pdf", bytes: 9 * 1024 * 1024 },
      { index: 1, filename: "second.pdf", bytes: 8 * 1024 * 1024 },
      { index: 2, filename: "script.bat", bytes: 100 },
      { index: 3, filename: "note.txt", bytes: 100 },
    ]);
    expect(split).toEqual({
      keep: [0, 3],
      skip: ["second.pdf", "script.bat"],
    });
  });

  it("assigns dated screenshot names to pasted images only when generic or unnamed", () => {
    const now = new Date(2026, 10, 23, 19, 45, 7);
    expect(pastedFileName({ name: "image.png", type: "image/png" }, now, 0)).toBe(
      "screenshot-20261123-194507.png",
    );
    expect(pastedFileName({ name: "", type: "image/webp" }, now, 1)).toBe(
      "screenshot-20261123-194507-2.webp",
    );
    expect(pastedFileName({ name: "logo.png", type: "image/png" }, now, 0)).toBe("logo.png");
  });

  it("treats clipboard paste as attachment only when files exist without plain text", () => {
    const fakeFile = { name: "image.png", size: 120 } as File;
    expect(clipboardAttachments({ files: [fakeFile], getData: () => "" })).toEqual([fakeFile]);
    expect(clipboardAttachments({ files: [fakeFile], getData: () => "copied cell" })).toEqual([]);
    expect(clipboardAttachments({ files: [], getData: () => "" })).toEqual([]);
  });
});
