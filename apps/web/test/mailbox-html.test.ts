import { describe, expect, it, vi } from "vitest";
import { projectMailboxHtml } from "../src/server/mailbox-html";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6q0cAAAAASUVORK5CYII=",
  "base64",
);

// A hidden image leaves its alt text, readable even inside font-size:0 cells.
const hidden = (alt: string) =>
  `<span style="font-size:12px;line-height:1.4;color:#80868b">${alt}</span>`;

describe("private mailbox HTML projection", () => {
  it("cuts a very long body instead of dropping it", () => {
    const paragraph = "<p>Linha de newsletter com bastante texto.</p>";
    const huge = `<h1>Topo</h1>${paragraph.repeat(Math.ceil((6 * 1024 * 1024) / paragraph.length))}`;
    const result = projectMailboxHtml(huge, []);
    expect(result.htmlBody).toContain("<h1>Topo</h1>");
    expect(result.htmlBody!.length).toBeLessThanOrEqual(5 * 1024 * 1024 + 1024);
  });
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

  it("keeps an email button's fill so its white label stays readable", () => {
    const result = projectMailboxHtml(
      '<center><table width="100%" border="0" bgcolor="#ffffff"><tr><td align="center" bgcolor="#d97757" style="border-radius:6px"><a href="https://platform.example/magic-link#token" style="display:inline-block;padding:12px 24px;color:#ffffff;background:#d97757;border:1px solid #d97757;font-weight:bold;text-decoration:none">Sign in</a></td></tr></table></center>',
      [],
    );
    const body = result.htmlBody ?? "";
    expect(body).toContain("<center>");
    expect(body).toContain('bgcolor="#d97757"');
    expect(body).toContain('width="100%"');
    expect(body).toContain("background:#d97757");
    expect(body).toContain("display:inline-block");
    expect(body).toContain("border:1px solid #d97757");
    expect(body).toContain("border-radius:6px");
    expect(body).toContain('href="https://platform.example/magic-link#token"');
    expect(body).toContain(">Sign in</a>");
  });

  it("drops a table colour or length that carries anything but a plain value", () => {
    const result = projectMailboxHtml(
      '<table width="javascript:1" border="url(x)" bgcolor="url(https://track.example/a)"><tr bgcolor="expression(alert(1))"><td bgcolor="#fff" height="40" width="100%;x" style="background:url(https://track.example/b);border:1px solid url(https://track.example/c)">Cell</td></tr></table>',
      [],
    );
    const body = result.htmlBody ?? "";
    expect(body).toContain('bgcolor="#fff"');
    expect(body).toContain('height="40"');
    expect(body).toContain(">Cell</td>");
    expect(body).not.toMatch(/track\.example|url\(|expression|javascript|width="100%;x"/i);
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
    expect(result.htmlBody).toBe(hidden("Attachment"));
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
    expect(result.htmlBody).toBe(hidden("Blocked"));
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
    expect(result.htmlBody).toContain(hidden("First"));
    expect(result.htmlBody).toContain("data:image/png;base64,");
    expect(
      result.htmlBodyWithExternalImages?.match(/src="https:\/\/public\.example\/image"/g),
    ).toHaveLength(2);
    expect(result.htmlBodyWithExternalImages).not.toMatch(/127\.0\.0\.1|hidden\.example/);
  });

  it("shows images from our own storage at once, keeping only their pixel size", () => {
    const html =
      '<img src="https://assets.example.com/logos/a.png" alt="Logo" width="96" height="48" onerror="x()">' +
      '<img src="https://assets.example.com.evil.example/b.png" alt="Lookalike">' +
      '<img src="https://other.example/c.png" alt="Other" width="100%">';
    const result = projectMailboxHtml(html, [], {
      trustedImagePrefix: "https://assets.example.com/",
    });
    expect(result.htmlBody).toContain(
      '<img src="https://assets.example.com/logos/a.png" alt="Logo" width="96" height="48" />',
    );
    expect(result.htmlBody).not.toMatch(/onerror|evil\.example|other\.example/);
    expect(result.externalImages).toBe(2);
    expect(result.htmlBodyWithExternalImages).toContain(
      'src="https://other.example/c.png" alt="Other" />',
    );
    // Without a configured store nothing is trusted.
    expect(projectMailboxHtml(html, []).externalImages).toBe(3);
  });

  it("keeps an email button's padding and centring shorthands, never a negative margin", () => {
    const result = projectMailboxHtml(
      '<a href="https://app.example/go" style="display:inline-block;padding:12px 24px;margin:0 auto;line-height:24px;letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap;background:#141413;color:#ffffff">Sign in</a><p style="margin:-999px 0;padding:1px 2px 3px 4px 5px">Lifted</p>',
      [],
    );
    expect(result.htmlBody).toContain("padding:12px 24px");
    expect(result.htmlBody).toContain("margin:0 auto");
    expect(result.htmlBody).toContain("line-height:24px");
    expect(result.htmlBody).toContain("letter-spacing:0.5px");
    expect(result.htmlBody).toContain("background:#141413");
    expect(result.htmlBody).not.toContain("-999px");
    expect(result.htmlBody).not.toContain("4px 5px");
  });

  it("drops tracking pixels outright: never shown, never offered", () => {
    const result = projectMailboxHtml(
      '<img src="https://track.example/open" width="1" height="1" alt=""><img src="https://track.example/o2" style="width:0px;height:0px"><img src="https://cdn.example/logo.png" alt="Logo" width="180" height="20">',
      [],
    );
    expect(result.externalImages).toBe(1);
    expect(result.htmlBody).not.toContain("track.example");
    expect(result.htmlBodyWithExternalImages).not.toContain("track.example");
    expect(result.htmlBodyWithExternalImages).toContain('src="https://cdn.example/logo.png"');
  });

  it("shows a CSS background image only with external images, and only from a public https host", () => {
    const result = projectMailboxHtml(
      `<div style="width:146px;height:146px;border-radius:20px;background-image:url('https://cdn.example/spark.png')">.</div><table><tbody><tr><td style="background:#ffffff url(https://cdn.example/hero.jpg) center / cover no-repeat;padding:8px">Hero</td></tr></tbody></table><div style="background-image:url(https://127.0.0.1/x.png)">Private</div><div style="background:url(data:image/png;base64,AAAA)">Data</div>`,
      [],
    );
    expect(result.externalImages).toBe(2);
    expect(result.htmlBody).not.toMatch(/url\(|cdn\.example|127\.0\.0\.1/);
    expect(result.htmlBody).toContain("width:146px;height:146px");
    expect(result.htmlBody).toContain("background-color:#ffffff");
    const shown = result.htmlBodyWithExternalImages ?? "";
    // The quotes are HTML-escaped inside the style attribute.
    expect(shown).toContain("background-image:url(&quot;https://cdn.example/spark.png&quot;)");
    expect(shown).toContain("background-image:url(&quot;https://cdn.example/hero.jpg&quot;)");
    expect(shown).toContain("background-repeat:no-repeat");
    expect(shown).toContain("background-size:cover");
    expect(shown).toContain("background-position:center");
    expect(shown).not.toMatch(/127\.0\.0\.1|data:image/);
  });

  it("keeps a hidden image's alt text readable inside a font-size:0 cell", () => {
    const result = projectMailboxHtml(
      '<table><tbody><tr><td style="font-size:0px"><img src="https://cdn.example/logo.png" alt="Claude Console"></td></tr></tbody></table>',
      [],
    );
    expect(result.htmlBody).toContain(hidden("Claude Console"));
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
      expect(body).toContain(hidden("Large"));
      expect(body).toContain("<p>End</p>");
    }
    expect(result.htmlBody?.match(/data:image\/png;base64,/g)?.length).toBe(
      result.htmlBodyWithExternalImages?.match(/data:image\/png;base64,/g)?.length,
    );
  });

  it.each([false, undefined, ""] as const)(
    "returns no projection for missing source HTML",
    (html) => {
      expect(projectMailboxHtml(html, [])).toEqual({
        htmlBody: null,
        htmlBodyWithExternalImages: null,
        externalImages: 0,
      });
    },
  );
});
