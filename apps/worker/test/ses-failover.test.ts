import { describe, expect, it } from "vitest";
import { parseSesFailover } from "../src/ses-failover.js";

describe("parseSesFailover", () => {
  it("is off when both variables are unset or blank", () => {
    expect(parseSesFailover(undefined, undefined)).toBeNull();
    expect(parseSesFailover(" ", " , ")).toBeNull();
  });

  it("reads one region and a normalized, frozen domain list", () => {
    const failover = parseSesFailover("eu-west-1", " MepMail.dev , other.example.com,");
    expect(failover?.region).toBe("eu-west-1");
    expect([...(failover?.domains ?? [])]).toEqual(["mepmail.dev", "other.example.com"]);
    expect(Object.isFrozen(failover)).toBe(true);
  });

  it.each([
    ["eu-west-1", undefined],
    [undefined, "mepmail.dev"],
    ["eu-west", "mepmail.dev"],
    ["EU-WEST-1", "mepmail.dev"],
    ["eu-west-1", "mepmail.dev,not a domain"],
    ["eu-west-1", "localhost"],
  ])("fails startup on a half or malformed setting (%s, %s)", (region, domains) => {
    expect(() => parseSesFailover(region, domains)).toThrow("ses_failover_invalid");
  });
});
