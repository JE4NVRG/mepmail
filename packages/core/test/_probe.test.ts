import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { redactRevealedText, renderRevealedBody } from "../src/content-reveal-render.js";

const plain = (c: { spans: { text: string }[] }) => c.spans.map((s) => s.text).join("");
const out: string[] = [];
const log = (k: string, v: string) => out.push(`${k}: ${JSON.stringify(v)}`);

describe("probe", () => {
  it("runs", () => {
    log("GLUED", plain(redactRevealedText(`${"A".repeat(40)}https://evil.example.com/reset?token=SECRETTOKEN123456789`)));
    log("NOBOUND2", plain(redactRevealedText("aaahttps://ex.com/r/TOKENabc123")));
    log("SCHEMELESS", plain(redactRevealedText("Go to www.bank-example.com/verify/9f3a2b7c1d")));
    log("SHORTPATH", plain(redactRevealedText("Open https://ex.com/u/8F3K2X")));
    log("SUBJ", plain(redactRevealedText("Seu codigo e 483920")));
    log("ENT", plain(renderRevealedBody({ html: "<p>go https&#58;//ex.com/r/TOKEN123456</p>", text: null })));
    log("MSO", plain(renderRevealedBody({ html: "<!--[if mso]><p>hidden branch code 998877</p><![endif]-->visible", text: null })));
    log("EMPTYHTML", plain(renderRevealedBody({ html: "", text: "PIN 4821 and https://ex.com/r/abc" })));
    log("HEX", plain(redactRevealedText(`key ${"a".repeat(32)}zz end`)));
    log("SPLIT", plain(renderRevealedBody({ html: "<p>Your code is <b>48</b><b>3920</b></p>", text: null })));
    log("ADDR", plain(redactRevealedText("Dear maria@acme.example.com, your account")));
    log("DATAURI", plain(redactRevealedText("img data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")));
    log("NOPATH", plain(redactRevealedText("see https://sub.example.com")));
    log("UPPER", plain(redactRevealedText("HTTPS://EX.COM/R/TOKEN1234567890123456789012345")));
    log("TWOURL", plain(redactRevealedText("https://a.example.com/x,https://b.example.com/secret-token-9f3a")));
    log("HIDDENNEST", plain(renderRevealedBody({ html: '<div style="display:none"><div>inner</div>hidden tail</div>after', text: null })));
    log("SCRIPT", plain(renderRevealedBody({ html: '<script>var to="victim@example.com"</script><p>hi</p>', text: null })));
    log("NOCLOSE", plain(renderRevealedBody({ html: '<p style="display:none">secret 123 <p>next', text: null })));
    writeFileSync("/tmp/claude-501/probe.txt", out.join("\n"));
  });
});
