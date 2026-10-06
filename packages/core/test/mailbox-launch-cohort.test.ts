import { describe, expect, it } from "vitest";
import {
  mailboxLaunchCohortAllows,
  parseMailboxLaunchCohort,
} from "../src/mailbox-launch-cohort.js";

const team = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const cutoff = "2026-10-06T12:00:00.000Z";
const now = new Date("2026-10-06T13:00:00.000Z");
const fixture = {
  version: 1,
  capturedAt: cutoff,
  members: [{ teamId: team, customerId: "cus_previous", subscriptionId: "sub_captured" }],
};
const parse = (value: unknown) => parseMailboxLaunchCohort(JSON.stringify(value));

describe("public Correio opening admission", () => {
  it("admits every team with a Stripe customer once the opening has passed", () => {
    const cohort = parse(fixture);
    expect(cohort).toEqual(fixture);
    expect(
      mailboxLaunchCohortAllows(cohort, { teamId: team, customerId: "cus_previous" }, now),
    ).toBe(true);
    expect(mailboxLaunchCohortAllows(cohort, { teamId: other, customerId: "cus_new29" }, now)).toBe(
      true,
    );
    expect(
      mailboxLaunchCohortAllows(cohort, { teamId: team, customerId: "cus_transfer" }, now),
    ).toBe(true);
  });
  it("still refuses a team that never became a Stripe customer", () => {
    const cohort = parse(fixture);
    expect(mailboxLaunchCohortAllows(cohort, { teamId: other, customerId: null }, now)).toBe(false);
  });
  it("retains enrollment after an Envio subscription replacement", () => {
    const cohort = parse(fixture);
    const current = { teamId: team, customerId: "cus_previous", subscriptionId: "sub_replacement" };
    expect(mailboxLaunchCohortAllows(cohort, current, now)).toBe(true);
    expect(cohort?.members[0]?.subscriptionId).toBe("sub_captured");
  });
  it("does not open a future capture or an invalid clock", () => {
    const cohort = parse(fixture);
    expect(
      mailboxLaunchCohortAllows(
        cohort,
        { teamId: team, customerId: "cus_previous" },
        new Date(cutoff),
      ),
    ).toBe(true);
    expect(
      mailboxLaunchCohortAllows(
        cohort,
        { teamId: team, customerId: "cus_previous" },
        new Date("2026-10-06T11:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      mailboxLaunchCohortAllows(
        cohort,
        { teamId: team, customerId: "cus_previous" },
        new Date("bad"),
      ),
    ).toBe(false);
  });
  it("distinguishes an absent legacy configuration from an invalid present one", () => {
    expect(mailboxLaunchCohortAllows(undefined, { teamId: team, customerId: null }, now)).toBe(
      true,
    );
    expect(mailboxLaunchCohortAllows(null, { teamId: team, customerId: "cus_previous" }, now)).toBe(
      false,
    );
    expect(parseMailboxLaunchCohort("invalid")).toBeNull();
    expect(parseMailboxLaunchCohort(undefined)).toBeNull();
  });
  it("admits paying teams even when the captured list of grants is empty", () => {
    const cohort = parse({ ...fixture, members: [] });
    expect(cohort).not.toBeNull();
    expect(
      mailboxLaunchCohortAllows(cohort, { teamId: team, customerId: "cus_previous" }, now),
    ).toBe(true);
  });
  it("requires an explicit true marker for the exceptional existing-US20 grant", () => {
    const member = fixture.members[0];
    expect(
      parse({ ...fixture, members: [{ ...member, grandfatheredTwentyDollarPlan: true }] }),
    ).not.toBeNull();
    expect(
      parse({ ...fixture, members: [{ ...member, grandfatheredTwentyDollarPlan: false }] }),
    ).toBeNull();
    expect(
      parse({ ...fixture, members: [{ ...member, grandfatheredTwentyDollarPlan: "true" }] }),
    ).toBeNull();
  });
  it.each([
    { ...fixture, capturedAt: "2026-10-06" },
    { ...fixture, capturedAt: "invalid" },
    { ...fixture, version: 2 },
    { ...fixture, unexpected: true },
    { ...fixture, members: [{ ...fixture.members[0], teamId: "invalid" }] },
    { ...fixture, members: [{ ...fixture.members[0], customerId: "cus_previous suffix" }] },
    { ...fixture, members: [{ ...fixture.members[0], subscriptionId: "sub_" }] },
    { ...fixture, members: [fixture.members[0], fixture.members[0]] },
    { ...fixture, members: [fixture.members[0], { ...fixture.members[0], teamId: other }] },
  ])("fails closed for malformed or ambiguous snapshots", (value) => {
    expect(parse(value)).toBeNull();
  });
});
