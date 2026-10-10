import { describe, expect, it } from "vitest";
import {
  defaultImportChoices,
  importFolderName,
  importProgress,
  importRunning,
  suggestImportTarget,
} from "./mailbox-import";

describe("mailbox history import", () => {
  it("suggests where each folder goes from its name, leaving trash, spam and drafts out", () => {
    expect(suggestImportTarget("INBOX")).toBe("inbox");
    expect(suggestImportTarget("Sent Items")).toBe("sent");
    expect(suggestImportTarget("[Gmail]/E-mails enviados")).toBe("sent");
    expect(suggestImportTarget("INBOX.Enviados")).toBe("sent");
    expect(suggestImportTarget("[Gmail]/Todos os e-mails")).toBe("archive");
    expect(suggestImportTarget("Archive")).toBe("archive");
    expect(suggestImportTarget("[Gmail]/Lixeira")).toBeNull();
    expect(suggestImportTarget("Junk E-mail")).toBeNull();
    expect(suggestImportTarget("Rascunhos")).toBeNull();
    expect(suggestImportTarget("Clientes/2024")).toBe("folder");
  });

  it("names the Correio folder after the remote path, within the folder rules", () => {
    expect(importFolderName("Clientes/2024")).toBe("Clientes / 2024");
    expect(importFolderName("  Projetos  ")).toBe("Projetos");
    expect(importFolderName("x".repeat(200))).toHaveLength(80);
  });

  it("starts from the server's targets when it gives them, else from the names", () => {
    expect(defaultImportChoices(["INBOX", "Sent", "Trash", "Leads"])).toEqual([
      { name: "INBOX", display: "INBOX", target: "inbox" },
      { name: "Sent", display: "Sent", target: "sent" },
      { name: "Leads", display: "Leads", target: "folder" },
    ]);
    expect(
      defaultImportChoices(
        ["Itens"],
        [{ name: "INBOX.Itens", display: "Itens", target: "archive" }],
      ),
    ).toEqual([{ name: "INBOX.Itens", display: "Itens", target: "archive" }]);
  });

  it("measures progress across folders and tells when an import is running", () => {
    expect(importProgress({ folders: [] })).toBeNull();
    expect(
      importProgress({
        folders: [
          { name: "INBOX", target: "inbox", total: 100, imported: 40, skipped: 5, failed: 5 },
          { name: "Sent", target: "sent", total: 100, imported: 0, skipped: 0, failed: 0 },
        ],
      }),
    ).toBe(0.25);
    expect(importRunning([{ state: "done" }, { state: "running" }])).toBe(true);
    expect(importRunning([{ state: "interrupted" }])).toBe(false);
    expect(importRunning(undefined)).toBe(false);
  });
});
