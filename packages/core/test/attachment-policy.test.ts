import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentFilenameBlocked,
  attachmentTypeAllowed,
  validateDispatchAttachment,
  validateDispatchAttachments,
} from "../src/attachment-policy.js";

const pdf = { filename: "nota.pdf", contentType: "application/pdf", size: 12_000 };

describe("nome de arquivo", () => {
  it("aceita um nome comum", () => {
    expect(attachmentFilenameBlocked("nota.pdf")).toBe(false);
    expect(attachmentFilenameBlocked("Relatório final 2026.docx")).toBe(false);
  });

  it.each([
    ["..", "../../etc/passwd"],
    ["barra", "pasta/nota.pdf"],
    ["barra invertida", "pasta\\nota.pdf"],
    ["controle", "nota\u0000.pdf"],
    ["bidi override", "nota\u202egnp.exe"],
    ["ponto final", "nota.pdf."],
    ["espaco final", "nota.pdf "],
    ["vazio", "   "],
    ["longo demais", `${"a".repeat(200)}.pdf`],
  ])("recusa %s", (_label, filename) => {
    expect(attachmentFilenameBlocked(filename)).toBe(true);
  });

  it.each(["virus.exe", "script.js", "macro.docm", "instalador.msi", "atalho.lnk", "run.ps1"])(
    "recusa extensao executavel %s",
    (filename) => {
      expect(attachmentFilenameBlocked(filename)).toBe(true);
    },
  );

  it("recusa executavel escondido atras de extensao inocente", () => {
    expect(attachmentFilenameBlocked("relatorio.pdf.exe")).toBe(true);
    expect(attachmentFilenameBlocked("relatorio.exe.pdf")).toBe(true);
    expect(attachmentFilenameBlocked("foto.jpg.scr")).toBe(true);
  });
});

describe("tipo declarado", () => {
  it("aceita os tipos do dia a dia", () => {
    expect(attachmentTypeAllowed("application/pdf")).toBe(true);
    expect(attachmentTypeAllowed("image/jpeg")).toBe(true);
    expect(attachmentTypeAllowed("text/csv")).toBe(true);
    expect(
      attachmentTypeAllowed("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(true);
  });

  it.each([
    "application/x-msdownload",
    "application/x-executable",
    "application/javascript",
    "application/octet-stream",
    "application/x-sh",
    "not-a-media-type",
    "",
  ])("recusa %s", (type) => {
    expect(attachmentTypeAllowed(type)).toBe(false);
  });

  it("ignora parametros do media type", () => {
    expect(attachmentTypeAllowed("application/pdf; name=nota.pdf")).toBe(true);
  });
});

describe("anexo isolado", () => {
  it("aceita o caso comum", () => {
    expect(validateDispatchAttachment(pdf)).toEqual({ ok: true });
  });

  it("recusa acima do limite", () => {
    expect(validateDispatchAttachment({ ...pdf, size: ATTACHMENT_MAX_BYTES + 1 })).toEqual({
      ok: false,
      detail: "attachment_too_large",
    });
  });

  it("recusa tamanho invalido", () => {
    expect(validateDispatchAttachment({ ...pdf, size: Number.NaN })).toEqual({
      ok: false,
      detail: "attachment_too_large",
    });
    expect(validateDispatchAttachment({ ...pdf, size: -1 })).toEqual({
      ok: false,
      detail: "attachment_too_large",
    });
  });

  it("recusa content-type falso mesmo com nome bom", () => {
    expect(validateDispatchAttachment({ ...pdf, contentType: "application/x-msdownload" })).toEqual(
      { ok: false, detail: "attachment_type_blocked" },
    );
  });

  it("recusa nome malicioso mesmo com tipo bom", () => {
    expect(validateDispatchAttachment({ ...pdf, filename: "nota.pdf.exe" })).toEqual({
      ok: false,
      detail: "attachment_name_blocked",
    });
  });
});

describe("lista", () => {
  it("aceita lista vazia e lista comum", () => {
    expect(validateDispatchAttachments([])).toEqual({ ok: true });
    expect(validateDispatchAttachments([pdf, { ...pdf, filename: "b.pdf" }])).toEqual({ ok: true });
  });

  it("recusa quantidade acima do limite", () => {
    const many = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) => ({
      ...pdf,
      filename: `n${i}.pdf`,
    }));
    expect(validateDispatchAttachments(many)).toEqual({
      ok: false,
      detail: "attachment_too_large",
    });
  });

  it("recusa total acima do limite mesmo com itens individuais validos", () => {
    // Cada item cabe sozinho; a soma estoura o teto do conjunto.
    const each = Math.floor(ATTACHMENT_MAX_BYTES * 0.8);
    const list = [
      { ...pdf, filename: "a.pdf", size: each },
      { ...pdf, filename: "b.pdf", size: each },
      { ...pdf, filename: "c.pdf", size: each },
    ];
    expect(each).toBeLessThan(ATTACHMENT_MAX_BYTES);
    expect(each * 3).toBeGreaterThan(ATTACHMENT_MAX_TOTAL_BYTES);
    expect(validateDispatchAttachments(list)).toEqual({
      ok: false,
      detail: "attachment_too_large",
    });
    expect(ATTACHMENT_MAX_TOTAL_BYTES).toBeLessThan(ATTACHMENT_MAX_BYTES * 3);
  });

  it("devolve o motivo do primeiro item invalido", () => {
    expect(
      validateDispatchAttachments([
        pdf,
        { filename: "malicioso.pdf", contentType: "application/pdf", size: 10 },
        { ...pdf, filename: "x.sh" },
      ]),
    ).toEqual({ ok: false, detail: "attachment_name_blocked" });
  });
});
