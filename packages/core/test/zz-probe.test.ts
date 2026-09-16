import { describe, expect, it } from "vitest";
import { redactRevealedText, renderRevealedBody } from "../src/content-reveal-render.js";
const plain = (c: any) => c.spans.map((s: any) => s.text).join("");
describe("probe", () => {
  it("word-glued scheme", () => {
    expect({
      one: plain(redactRevealedText("aaahttps://ex.com/r/TOKENabc123")),
      two: plain(redactRevealedText("A".repeat(40) + "https://evil.example.com/reset?token=SECRETTOKEN123456789")),
      underscore: plain(redactRevealedText("_https://ex.com/r/TOKENabc1234567890")),
      slash: plain(redactRevealedText("/https://ex.com/r/TOKENabc1234567890")),
      htmlTag: plain(renderRevealedBody({html: '<b>click</b>https://ex.com/r/TOKENabc1234567890', text: null})),
      anchor: plain(renderRevealedBody({html: '<a href="x">https://ex.com/r/TOKENabc1234567890</a>', text: null})),
      entity: plain(renderRevealedBody({html: 'click&#65;https://ex.com/r/TOKENabc1234567890', text: null})),
      hexglue: plain(redactRevealedText("a".repeat(32) + "https://ex.com/r/TOKENabc1234567890")),
      normal: plain(redactRevealedText("Reset: https://ex.com/r/TOKENabc1234567890")),
    }).toBe("SHOWME");
  });
});
