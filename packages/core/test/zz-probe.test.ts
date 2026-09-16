import { describe, expect, it } from "vitest";
import { redactRevealedText, renderRevealedBody } from "../src/content-reveal-render.js";
const U = "https://login.acme.example.co.uk/r?token=abcdefghijklmnopqrstuvwxyz0123456789";
const plain = (c: any) => c.spans.map((s: any) => s.text).join("");
describe("probe", () => {
  it("word-glued scheme", () => {
    expect({
      normal: plain(redactRevealedText("Reset: " + U)),
      slash: plain(redactRevealedText("/" + U)),
      underscore: plain(redactRevealedText("_" + U)),
      letter: plain(redactRevealedText("aaa" + U)),
      digit: plain(redactRevealedText("2" + U)),
      hexglue: plain(redactRevealedText("a".repeat(32) + U)),
      b64glue: plain(redactRevealedText("A".repeat(40) + U)),
      htmlTag: plain(renderRevealedBody({html: '<b>click</b>' + U, text: null})),
      entity: plain(renderRevealedBody({html: 'click&#65;' + U, text: null})),
      nbsp: plain(renderRevealedBody({html: 'click&nbsp;' + U, text: null})),
    }).toBe("SHOWME");
  });
});
