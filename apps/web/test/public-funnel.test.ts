import { describe, expect, it } from "vitest";
import { arrivalEvent, visitSource } from "@/lib/public-funnel";

/**
 * The public site's campaign events (launch-ops.md §3.2), as rules.
 *
 * The components only supply the browser's cookie and query string; what they
 * decide lives here, so the channels the launch plan tracks can be pinned
 * without a DOM. A wrong name or a channel counted as another is exactly the
 * kind of silent error the 24h/72h report would carry into the launch read.
 */

/** The cookie the proxy writes: encoded JSON of the raw visit. */
function attributionCookie(visit: Record<string, string>): string {
  return `mm_attr=${encodeURIComponent(JSON.stringify(visit))}`;
}

describe("arrivalEvent", () => {
  it("names the Show HN arrival from utm_medium=show_hn, with its utm_content", () => {
    expect(
      arrivalEvent(
        "?utm_source=hackernews&utm_medium=show_hn&utm_campaign=launch-2026-10&utm_content=hn-body",
      ),
    ).toEqual({ name: "hn_arrival", props: { utm_content: "hn-body" } });
  });

  it("names the Product Hunt arrival from utm_medium=launch", () => {
    expect(
      arrivalEvent(
        "?utm_source=producthunt&utm_medium=launch&utm_campaign=launch-2026-10&utm_content=ph-maker-comment",
      ),
    ).toEqual({ name: "ph_arrival", props: { utm_content: "ph-maker-comment" } });
  });

  it("tells the two Reddit subs apart only by utm_content, both under utm_source=reddit", () => {
    // Both subs share medium=post, which is why the rule keys on the source.
    expect(arrivalEvent("?utm_source=reddit&utm_medium=post&utm_content=selfhosted")).toEqual({
      name: "reddit_arrival",
      props: { utm_content: "selfhosted" },
    });
    expect(arrivalEvent("?utm_source=reddit&utm_medium=post&utm_content=sideproject")).toEqual({
      name: "reddit_arrival",
      props: { utm_content: "sideproject" },
    });
  });

  it("omits utm_content (rather than sending it empty) when the link carried none", () => {
    expect(arrivalEvent("?utm_source=hackernews&utm_medium=show_hn")).toEqual({
      name: "hn_arrival",
      props: {},
    });
  });

  it("fires nothing for a visit that names no tracked campaign", () => {
    expect(arrivalEvent("")).toBeNull();
    expect(arrivalEvent("?utm_source=x&utm_medium=thread&utm_content=tweet-7")).toBeNull();
    expect(arrivalEvent("?utm_source=devto&utm_medium=article")).toBeNull();
    // Reddit's medium alone is not the channel: the source is what names it.
    expect(arrivalEvent("?utm_medium=post&utm_content=selfhosted")).toBeNull();
  });
});

describe("visitSource", () => {
  it("reads the utm_source the proxy recorded, past any other cookie", () => {
    const header = `theme=dark; ${attributionCookie({
      source: "hackernews",
      medium: "show_hn",
      path: "/",
    })}; session=abc`;
    expect(visitSource(header)).toBe("hackernews");
  });

  it("is undefined when there is no attribution cookie to read", () => {
    // A direct visit, a cleared browser: nothing to attribute, so the prop is
    // omitted instead of reporting the sign-up as a channel it never had.
    expect(visitSource(undefined)).toBeUndefined();
    expect(visitSource(null)).toBeUndefined();
    expect(visitSource("theme=dark; session=abc")).toBeUndefined();
  });

  it("treats a malformed cookie the same as no cookie", () => {
    expect(visitSource("mm_attr=not-json")).toBeUndefined();
    expect(visitSource("mm_attr=%5B%22hackernews%22%5D")).toBeUndefined();
  });
});
