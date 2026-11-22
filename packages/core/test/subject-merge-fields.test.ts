import { describe, expect, it } from "vitest";
import { validateSubjectMergeFields } from "../src/broadcast-content.js";

describe("subject merge fields (15.3)", () => {
  it("allows the two harmless builtins the gate can reason about", () => {
    expect(validateSubjectMergeFields("Oi {{{FIRST_NAME}}}, tudo bem?")).toEqual({
      ok: true,
      rejected: [],
    });
    expect(validateSubjectMergeFields("Recibo para {{{email}}}")).toEqual({
      ok: true,
      rejected: [],
    });
  });

  it("rejects a tag that could expand into copy the gate never screens", () => {
    const verdict = validateSubjectMergeFields("{{{offer_kind}}} para você");
    expect(verdict.ok).toBe(false);
    expect(verdict.rejected).toEqual(["offer_kind"]);
  });

  it("rejects LAST_NAME, which is not on the allowlist", () => {
    const verdict = validateSubjectMergeFields("{{{FIRST_NAME}}} {{{LAST_NAME}}}, olha isso");
    expect(verdict.ok).toBe(false);
    expect(verdict.rejected).toEqual(["LAST_NAME"]);
  });

  it("leaves a subject without merge fields alone", () => {
    expect(validateSubjectMergeFields("Novidades do MepMail em novembro")).toEqual({
      ok: true,
      rejected: [],
    });
  });
});
