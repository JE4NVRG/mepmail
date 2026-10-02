import { describe, expect, it } from "vitest";
import { parseMailboxInboundConfiguration } from "../../worker/src/mailbox-ingress.js";

const config = {
  region: "us-east-1",
  topics: ["arn:aws:sns:us-east-1:123456789012:private-mail-receipts"],
  locations: [
    { bucket: "private-mail-fixture", prefix: "receipts/", ownerAccountId: "123456789012" },
  ],
};
describe("private mailbox operator configuration", () => {
  it("keeps absent ingress off and accepts explicit private AWS locations", () => {
    expect(parseMailboxInboundConfiguration(undefined)).toBeNull();
    expect(parseMailboxInboundConfiguration(" ")).toBeNull();
    expect(parseMailboxInboundConfiguration(JSON.stringify(config))).toEqual(config);
  });
  it("rejects topic region/account mismatches and duplicates", () => {
    for (const invalid of [
      { ...config, region: "eu-west-1" },
      { ...config, locations: [{ ...config.locations[0], ownerAccountId: "999999999999" }] },
      { ...config, topics: [...config.topics, ...config.topics] },
      { ...config, locations: [...config.locations, ...config.locations] },
    ])
      expect(() => parseMailboxInboundConfiguration(JSON.stringify(invalid))).toThrow(
        "Invalid private mailbox inbound configuration",
      );
  });
  it("rejects custom endpoints, bucket URLs, traversal and unexpected fields", () => {
    for (const invalid of [
      { ...config, endpoint: "https://assets.example.invalid" },
      {
        ...config,
        locations: [{ ...config.locations[0], bucket: "https://assets.example.invalid" }],
      },
      { ...config, locations: [{ ...config.locations[0], prefix: "receipts/../" }] },
      { ...config, locations: [{ ...config.locations[0], prefix: "/receipts/" }] },
      { ...config, locations: [{ ...config.locations[0], prefix: "" }] },
      { ...config, locations: [{ ...config.locations[0], public: true }] },
    ])
      expect(() => parseMailboxInboundConfiguration(JSON.stringify(invalid))).toThrow(
        "Invalid private mailbox inbound configuration",
      );
  });
});
