import { describe, expect, it, vi } from "vitest";
import { projectMailboxHtml } from "../src/server/mailbox-html";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6q0cAAAAASUVORK5CYII=",
  "base64",
);

describe("private mailbox HTML projection", () => {
  it("retains bounded formatting and makes links explicit new-tab navigation", () => {
    const result = projectMailboxHtml(
      '<h2>Hello</h2><table cellpadding="4"><tr><td style="color:#fff;font-size:14px">Content</td></tr></table><a href="https://public.example/page" target="_self" rel="opener" ping="https://track.example">Open</a>',
      [],
    );
    expect(result.htmlBody).toContain("<h2>Hello</h2>");
    expect(result.htmlBody).toContain("color:#fff");
    expect(result.htmlBody).toContain("font-size:14px");
    expect(result.htmlBody).toContain('href="https://public.example/page"');
    expect(result.htmlBody).toContain('target="_blank" rel="noopener noreferrer"');
    expect(result.htmlBody).not.toContain("ping=");
    expect(result.htmlBodyWithExternalImages).toBeNull();
  });

  it("removes active markup, embedded documents, forms, redirects and event handlers", () => {
    const result = projectMailboxHtml(
      '<script>alert(1)</script><style>@import "https://track.example/style";</style><form action="https://track.example"><input name="secret"><button>Submit</button></form><meta http-equiv="refresh" content="0;url=https://track.example"><base href="https://track.example"><link rel="prefetch" href="https://track.example"><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://track.example"></object><embed src="https://track.example"><svg onload="alert(1)"><script>alert(1)</script></svg><math><mtext>Hidden</mtext></math><p onclick="alert(1)">Visible</p>',
      [],
    );
    expect(result.htmlBody).toContain("<p>Visible</p>");
    expect(result.htmlBody).not.toMatch(
      /<(?:script|style|form|input|button|meta|base|link|iframe|object|embed|svg|math)\b/i,
    );
    expect(result.htmlBody).not.toMatch(/on(?:click|load|error)=|srcdoc=|alert\(1\)|@import/i);
    expect(result.externalImages).toBe(0);
  });

  it.each([
    "javascript:alert(1)",
    "javascript&#58;alert(1)",
    "jav&#x61;script:alert(1)",
    "java&#10;script:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "//track.example/path",
  ])("removes unsafe link scheme %s", (href) => {
    const result = projectMailboxHtml(`<a href="${href}">Open</a>`, []);
    expect(result.htmlBody).not.toContain("href=");
  });

  it("rejects CSS URLs, expressions and overlays while preserving allowlisted appearance", () => {
    const result = projectMailboxHtml(
      '<p style="background-image:url(https://track.example/pixel);background-color:url(https://track.example);color:expression(alert(1));font-family:url(https://track.example/font);position:fixed;inset:0;z-index:999;filter:url(https://track.example);-moz-binding:url(https://track.example);font-size:14px;text-align:center">Visible</p><div style="background-color:u\\72l(https://track.example);color:red">Safe</div>',
      [],
    );
    expect(result.htmlBody).toContain("font-size:14px");
    expect(result.htmlBody).toContain("text-align:center");
    expect(result.htmlBody).toContain("color:red");
    expect(result.htmlBody).not.toMatch(
      /track\.example|url\(|expression|position:|z-index|binding/i,
    );
  });

  it("embeds only a known CID whose bytes qualify as a bounded raster image", () => {
    const result = projectMailboxHtml(
      '<p>Image</p><img src="CID:logo" alt="Company" onerror="alert(1)" srcset="https://track.example/pixel">',
      [{ contentId: "<logo>", content: png }],
    );
    expect(result.htmlBody).toContain(`src="data:image/png;base64,${png.toString("base64")}"`);
    expect(result.htmlBody).toContain('alt="Company"');
    expect(result.htmlBody).not.toMatch(/onerror=|srcset=|track\.example/);
    expect(result.externalImages).toBe(0);
    expect(result.htmlBodyWithExternalImages).toBeNull();
  });

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    Buffer.from("<html><script>alert(1)</script></html>"),
    Buffer.from("not an image"),
    Buffer.alloc(256 * 1024 + 1),
  ])("does not trust MIME labels or arbitrary CID bytes", (content) => {
    const result = projectMailboxHtml('<img src="cid:untrusted" alt="Attachment">', [
      { contentId: "untrusted", content },
    ]);
    expect(result.htmlBody).toBe("<span>Attachment</span>");
    expect(result.externalImages).toBe(0);
  });

  it("rejects raw data URLs and unknown CID references, escaping their fallback text", () => {
    const result = projectMailboxHtml(
      `<img src="data:image/png;base64,${png.toString("base64")}" alt="Raw"><img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;" alt="SVG"><img src="cid:missing" alt="&lt;img src=x onerror=alert(1)&gt;">`,
      [],
    );
    expect(result.htmlBody).not.toContain("<img");
    expect(result.htmlBody).not.toMatch(/<[^>]+\ssrc=/);
    expect(result.htmlBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(result.externalImages).toBe(0);
  });

  it.each([
    "http://public.example/image",
    "https://localhost/image",
    "https://localhost../image",
    "https://box.local/image",
    "https://box.internal/image",
    "https://router.localdomain/image",
    "https://router.lan/image",
    "https://router.home.arpa/image",
    "https://127.0.0.1/image",
    "https://10.0.0.1/image",
    "https://169.254.169.254/image",
    "https://2130706433/image",
    "https://0x7f000001/image",
    "https://[::1]/image",
    "https://[::ffff:127.0.0.1]/image",
    "https://user:password@public.example/image",
    "https://bad..example/image",
    "//public.example/image",
    "/api/mailboxes/private/attachment",
  ])("never offers external images for private, ambiguous or unsafe source %s", (src) => {
    const result = projectMailboxHtml(`<img src="${src}" alt="Blocked">`, []);
    expect(result.htmlBody).toBe("<span>Blocked</span>");
    expect(result.htmlBodyWithExternalImages).toBeNull();
    expect(result.externalImages).toBe(0);
  });

  it("counts eligible visible external image occurrences and offers them only in the alternate projection", () => {
    const result = projectMailboxHtml(
      '<img src="https://public.example/image" alt="First"><img src="https://public.example/image" alt="Second"><img src="cid:logo"><img src="https://127.0.0.1/private"><iframe><img src="https://hidden.example/image"></iframe>',
      [{ contentId: "logo", content: png }],
    );
    expect(result.externalImages).toBe(2);
    expect(result.htmlBody).not.toMatch(/src="https?:/);
    expect(result.htmlBody).toContain("<span>First</span>");
    expect(result.htmlBody).toContain("data:image/png;base64,");
    expect(
      result.htmlBodyWithExternalImages?.match(/src="https:\/\/public\.example\/image"/g),
    ).toHaveLength(2);
    expect(result.htmlBodyWithExternalImages).not.toMatch(/127\.0\.0\.1|hidden\.example/);
  });

  it("projects external URLs locally without fetching or rewriting them through a private proxy", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network is disabled in this projection test");
    });
    try {
      const result = projectMailboxHtml('<img src="https://public.example/image">', []);
      expect(fetch).not.toHaveBeenCalled();
      expect(result.htmlBody).not.toContain("https://public.example/image");
      expect(result.htmlBodyWithExternalImages).toContain('src="https://public.example/image"');
      expect(result.htmlBodyWithExternalImages).not.toContain("/api/mailboxes/");
    } finally {
      fetch.mockRestore();
    }
  });

  it("bounds repeated CID expansion independently for both projections without dropping trailing text", () => {
    const large = Buffer.alloc(200 * 1024);
    png.copy(large, 0, 0, 33);
    Buffer.from("IEND").copy(large, large.length - 8);
    const html = `${'<img src="cid:large" alt="Large">'.repeat(30)}<img src="https://public.example/image"><p>End</p>`;
    const result = projectMailboxHtml(html, [{ contentId: "large", content: large }]);
    for (const body of [result.htmlBody, result.htmlBodyWithExternalImages]) {
      expect(body?.length).toBeLessThan(2 * 1024 * 1024);
      expect(body).toContain("data:image/png;base64,");
      expect(body).toContain("<span>Large</span>");
      expect(body).toContain("<p>End</p>");
    }
    expect(result.htmlBody?.match(/data:image\/png;base64,/g)?.length).toBe(
      result.htmlBodyWithExternalImages?.match(/data:image\/png;base64,/g)?.length,
    );
  });

  it.each([false, undefined, "", "x".repeat(1024 * 1024 + 1)] as const)(
    "returns no projection for missing or oversized source HTML",
    (html) => {
      expect(projectMailboxHtml(html, [])).toEqual({
        htmlBody: null,
        htmlBodyWithExternalImages: null,
        externalImages: 0,
      });
    },
  );
});
