import { describe, expect, it } from "vitest";
import { assessSignupRisk, type SignupRiskSignals } from "../src/signup-risk-policy.js";

const signals = (change: Partial<SignupRiskSignals> = {}): SignupRiskSignals => ({
  domain: "gmail.com",
  disposable: false,
  mx: "present",
  domainAgeDays: 9_000,
  catchAll: "unknown",
  randomLocal: false,
  ipKey: "synthetic-hmac",
  asn: 15169,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
  ...change,
});

describe("signup risk policy v1", () => {
  it.each([
    { randomLocal: true },
    { domainAgeDays: 2 },
    { signupsIp1h: 3 },
    { signupsDomain24h: 3 },
    { signupsAsn1h: 12 },
    { rapidFullKey: true },
    { mx: "unknown" as const },
    { mx: "null" as const },
    { mx: "absent" as const },
    { domainAgeDays: null },
  ])("does not restrict a single weak signal: %j", (change) => {
    expect(assessSignupRisk(signals(change)).level).toBe("good");
  });

  it("does not punish random Gmail addresses merely for a mature provider ASN or fast key", () => {
    expect(
      assessSignupRisk(signals({ randomLocal: true, signupsAsn1h: 11, rapidFullKey: true })).level,
    ).toBe("good");
  });

  it("sandboxes a listed disposable domain without claiming abuse", () => {
    const assessment = assessSignupRisk(signals({ domain: "mailinator.com", disposable: true }));
    expect(assessment).toMatchObject({ level: "sandbox", policyVersion: 1 });
    expect(assessment.reasons).toContain("disposable_domain");
  });

  it.each([
    { randomLocal: true },
    { rapidFullKey: true },
    { signupsIp1h: 3 },
    { signupsDomain24h: 3 },
    { signupsAsn1h: 12 },
  ])("sandboxes young domain with an additional signal: %j", (change) => {
    expect(
      assessSignupRisk(signals({ domain: "new-company.com", domainAgeDays: 2, ...change })).level,
    ).toBe("sandbox");
  });

  it.each([
    { signupsIp1h: 3 },
    { signupsDomain24h: 3 },
    { signupsAsn1h: 12 },
    { rapidFullKey: true },
  ])("holds a young random identity with corroboration: %j", (change) => {
    expect(
      assessSignupRisk(signals({ domainAgeDays: 2, randomLocal: true, ...change })).level,
    ).toBe("hold");
  });

  it.each([{ signupsIp1h: 3 }, { signupsDomain24h: 3 }, { signupsAsn1h: 12 }])(
    "holds disposable plus random plus burst, even with unknown age: %j",
    (change) => {
      expect(
        assessSignupRisk(
          signals({ disposable: true, randomLocal: true, domainAgeDays: null, ...change }),
        ).level,
      ).toBe("hold");
    },
  );

  it("does not hold disposable plus velocity without random identity evidence", () => {
    expect(assessSignupRisk(signals({ disposable: true, signupsIp1h: 100 })).level).toBe("sandbox");
  });

  it("keeps an unknown-age identity burst in sandbox instead of treating RDAP failure as a hold", () => {
    const assessment = assessSignupRisk(
      signals({ domainAgeDays: null, randomLocal: true, signupsIp1h: 3 }),
    );
    expect(assessment.level).toBe("sandbox");
    expect(assessment.reasons).toContain("unknown_age_identity_burst");
  });

  it.each(["null", "absent"] as const)("combines %s MX with identity evidence only", (mx) => {
    expect(assessSignupRisk(signals({ mx })).level).toBe("good");
    expect(assessSignupRisk(signals({ mx, randomLocal: true })).level).toBe("sandbox");
  });

  it("does not treat unknown MX as null or absent MX", () => {
    expect(assessSignupRisk(signals({ mx: "unknown", randomLocal: true })).level).toBe("good");
  });

  it.each([13, 26])(
    "holds a %s-day domain only with random identity plus a rapid full key",
    (domainAgeDays) => {
      expect(assessSignupRisk(signals({ domain: "new-company.com", domainAgeDays })).level).toBe(
        "good",
      );
      expect(
        assessSignupRisk(
          signals({
            domain: "new-company.com",
            domainAgeDays,
            randomLocal: true,
            rapidFullKey: true,
          }),
        ).level,
      ).toBe("hold");
    },
  );

  it("sandboxes an older random identity burst without claiming the mature domain is disposable", () => {
    const assessment = assessSignupRisk(
      signals({
        domain: "established-company.com",
        domainAgeDays: 159,
        randomLocal: true,
        signupsDomain24h: 3,
      }),
    );
    expect(assessment.level).toBe("sandbox");
    expect(assessment.reasons).toContain("identity_burst");
    expect(assessment.reasons).not.toContain("disposable_domain");
  });

  it("honors exact age and burst boundaries", () => {
    const young = signals({
      domainAgeDays: 29,
      randomLocal: true,
      signupsIp1h: 2,
      signupsDomain24h: 2,
      signupsAsn1h: 11,
    });
    expect(assessSignupRisk(young).level).toBe("sandbox");
    expect(assessSignupRisk({ ...young, signupsIp1h: 3 }).level).toBe("hold");
    expect(assessSignupRisk({ ...young, domainAgeDays: 30, rapidFullKey: true }).level).toBe(
      "good",
    );
  });

  it("ignores malformed counters and counters without their network identity", () => {
    expect(
      assessSignupRisk(
        signals({
          domainAgeDays: 2,
          randomLocal: true,
          signupsIp1h: Number.NaN,
          signupsDomain24h: -1,
          signupsAsn1h: 12.5,
        }),
      ).level,
    ).toBe("sandbox");
    expect(
      assessSignupRisk(
        signals({
          domainAgeDays: 2,
          randomLocal: true,
          ipKey: null,
          asn: null,
          signupsIp1h: 10,
          signupsAsn1h: 100,
        }),
      ).level,
    ).toBe("sandbox");
  });

  it.each(["", "localhost", "192.168.1.1", "good.com/path"])(
    "never marks an invalid domain good: %s",
    (domain) => {
      expect(assessSignupRisk(signals({ domain }))).toEqual({
        level: "sandbox",
        reasons: ["invalid_email_domain"],
        policyVersion: 1,
      });
    },
  );
});
