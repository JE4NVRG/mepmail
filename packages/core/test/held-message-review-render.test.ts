import { describe, expect, it } from "vitest";
import { renderHeldMessageReview } from "../src/held-message-review-render.js";

describe("held-message review transport redaction", () => {
  it("masks prefixed keys glued to identifiers and JSON values", () => {
    const glued = ["sk", "live", "aB3dE5fG7hJ9kL2mN4pQ6rS8"].join("_");
    const nested = ["rk", "live", "xY7zA1bC3dE5fG7hJ9kL2mN4"].join("_");
    const result = renderHeldMessageReview("Revisão", {
      html: null,
      text: `backup_${glued} ${JSON.stringify({ key: nested })}`,
    });
    expect(JSON.stringify(result)).not.toMatch(/sk_live_|rk_live_|aB3dE5|xY7zA1/);
  });

  it("preserves link destination evidence for encoded, relative-protocol and IP URLs", () => {
    const result = renderHeldMessageReview("Revisão", {
      html: '<a href="//evil.example/path?token=x">Continuar</a><a href="https&#58;//verify.example.org/private">Abrir</a><p>http://10.23.45.67/private?key=x</p><a href="http://[::1]/secret">Outro</a>',
      text: null,
    });
    expect(result.linkHosts).toEqual(["10.23.45.67", "::1", "evil.example", "example.org"]);
    expect(JSON.stringify(result)).not.toMatch(/path\?|private|secret|token=x|key=x/);
    expect(JSON.stringify(result)).toContain("10.23.45.67");
  });

  it("keeps visible evidence while stripping URL paths and credentials", () => {
    const result = renderHeldMessageReview("Código 748291", {
      html: '<p>Atualize o cadastro.</p><a href="https://user:private@login.example.org/token-secret?otp=1234#secret">Continuar</a><script>doNotExecute()</script><div style="display:none">hidden secret</div>',
      text: "ignored private fallback",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Atualize o cadastro");
    expect(result.linkHosts).toEqual(["example.org"]);
    for (const secret of [
      "748291",
      "user:private",
      "token-secret",
      "otp=1234",
      "#secret",
      "doNotExecute",
      "hidden secret",
      "ignored private fallback",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("masks credentials, addresses and identifiers in plain text and subject", () => {
    const syntheticKey = ["sk", "live", "a".repeat(29)].join("_");
    const result = renderHeldMessageReview("Revisão owner@example.org", {
      html: null,
      text: `token=superPrivateValue senha:OnlyInMemory owner@example.org telefone +55 (11) 98888-7777 ${syntheticKey} https://example.org/short-code?secret=yes`,
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "owner@example.org",
      "superPrivateValue",
      "OnlyInMemory",
      "98888",
      "sk_live_",
      "short-code",
      "secret=yes",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("example.org");
    expect(result.redactions).toBeGreaterThan(0);
  });

  it("bounds output and never returns executable HTML", () => {
    const result = renderHeldMessageReview("x".repeat(4_000), {
      html: `<p>${"a".repeat(30_000)}</p><img src="https://tracking.example.org/pixel/private-id">`,
      text: null,
    });
    expect(result.subject.map((s) => s.text).join("").length).toBeLessThanOrEqual(2_000);
    expect(result.spans.map((s) => s.text).join("").length).toBeLessThanOrEqual(20_001);
    expect(JSON.stringify(result)).not.toMatch(/<p>|<img|private-id/);
    expect(result.linkHosts).toEqual(["example.org"]);
  });
});
