import { describe, expect, it } from "vitest";
import {
  assertMailboxSesOutboundBindings,
  assertMailboxSesOutboundTopics,
  copyMailboxSesOutboundRegions,
  parseMailboxSesOutboundRegions,
  resolveMailboxSesOutboundRegion,
} from "../src/mailbox-outbound-region.js";

const row = {
  teamId: "11111111-1111-4111-8111-111111111111",
  domainId: "22222222-2222-4222-8222-222222222222",
  domain: "example.invalid",
  region: "eu-west-1",
};
describe("explicit Native outbound bindings", () => {
  it("rejects unknown and mismatched database records at activation, without writes", async () => {
    await expect(
      assertMailboxSesOutboundBindings([row], async (ids) => {
        expect(ids).toEqual([row.domainId]);
        return [row];
      }),
    ).resolves.toBeUndefined();
    for (const result of [
      [],
      [{ ...row, teamId: "other" }],
      [{ ...row, domainId: "other" }],
      [{ ...row, domain: "other.invalid" }],
    ])
      await expect(assertMailboxSesOutboundBindings([row], async () => result)).rejects.toThrow(
        "mailbox_ses_outbound_region_binding",
      );
    await expect(
      assertMailboxSesOutboundBindings([row], async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("mailbox_ses_outbound_region_binding");
    await expect(
      assertMailboxSesOutboundBindings([], async () => {
        throw new Error("must_not_query");
      }),
    ).resolves.toBeUndefined();
  });
  it("requires a trusted evidence topic in every explicit destination", () => {
    expect(() => assertMailboxSesOutboundTopics([row], [])).toThrow(
      "mailbox_ses_outbound_evidence_topic_missing",
    );
    expect(() =>
      assertMailboxSesOutboundTopics([row], ["arn:aws:sns:us-east-1:123456789012:events"]),
    ).toThrow("mailbox_ses_outbound_evidence_topic_missing");
    expect(() =>
      assertMailboxSesOutboundTopics([row], ["arn:aws:sns:eu-west-1:123456789012:events"]),
    ).not.toThrow();
    expect(() => assertMailboxSesOutboundTopics([], [])).not.toThrow();
  });
  it("rejects duplicate raw JSON keys including escaped equivalents", () => {
    const json = JSON.stringify([row]);
    for (const key of ['"region"', '"reg\\u0069on"']) {
      const duplicated = json.replace(
        '"region":"eu-west-1"',
        '"region":"us-east-1",' + key + ':"eu-west-1"',
      );
      expect(() => parseMailboxSesOutboundRegions(duplicated)).toThrow(
        "mailbox_ses_outbound_regions_invalid",
      );
    }
  });
  it("parses immutable exact entries without normalizing identifiers or domains", () => {
    expect(parseMailboxSesOutboundRegions()).toEqual([]);
    expect(parseMailboxSesOutboundRegions(" ")).toEqual([]);
    const parsed = parseMailboxSesOutboundRegions(JSON.stringify([row]));
    expect(parsed).toEqual([row]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    const mutable = [{ ...row }];
    const captured = copyMailboxSesOutboundRegions(mutable);
    mutable[0]!.region = "us-east-1";
    expect(captured[0]!.region).toBe("eu-west-1");
  });
  it.each([
    "invalid",
    "null",
    "{}",
    "[null]",
    JSON.stringify([{}]),
    ...[
      { ...row, teamId: "*" },
      { ...row, domainId: "bad" },
      { ...row, domain: "*.example.invalid" },
      { ...row, domain: "Example.invalid" },
      { ...row, domain: "example.invalid." },
      { ...row, region: "xx-unknown-1" },
      { ...row, region: "eu-west-1 " },
      { ...row, extra: true },
      { ...row, domain: "bad..invalid" },
      { ...row, domain: "-bad.invalid" },
    ].map((value) => JSON.stringify([value])),
    JSON.stringify([row, row]),
    JSON.stringify([row, { ...row, domain: "other.invalid" }]),
    JSON.stringify([row, { ...row, domainId: "33333333-3333-4333-8333-333333333333" }]),
    JSON.stringify(Array.from({ length: 257 }, () => row)),
    " ".repeat(65537) + "[]",
  ])("rejects malformed/ambiguous operator JSON %s", (value) => {
    expect(() => parseMailboxSesOutboundRegions(value)).toThrow(
      "mailbox_ses_outbound_regions_invalid",
    );
  });
  it("matches all three authorities, defers stale/mismatched bindings, leaves unrelated domains unchanged", () => {
    const entries = parseMailboxSesOutboundRegions(JSON.stringify([row]));
    const bound = { ...row, region: "us-east-1" };
    expect(resolveMailboxSesOutboundRegion(entries, bound)).toBe("eu-west-1");
    expect(resolveMailboxSesOutboundRegion([], bound)).toBe("us-east-1");
    for (const bad of [
      { ...bound, teamId: "other" },
      { ...bound, domain: "other.invalid" },
      { ...bound, domainId: "other" },
    ])
      expect(() => resolveMailboxSesOutboundRegion(entries, bad)).toThrow(
        "mailbox_ses_outbound_region_binding",
      );
    expect(
      resolveMailboxSesOutboundRegion(entries, { ...bound, teamId: "other", domainId: "other" }),
    ).toBe("us-east-1");
  });
});
