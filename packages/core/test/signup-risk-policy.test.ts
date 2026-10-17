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

describe("signup risk policy v2", () => {
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
    { verificationSeconds: 8 },
    { genericTeamName: true },
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
    expect(assessment).toMatchObject({ level: "sandbox", policyVersion: 2 });
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

  it("sandboxes the first-wave regression with unknown age, random identity and a 19-second full key", () => {
    const assessment = assessSignupRisk(
      signals({
        domain: "first-observed-shop.test",
        domainAgeDays: null,
        randomLocal: true,
        rapidFullKey: true,
      }),
    );
    expect(assessment).toMatchObject({ level: "sandbox", policyVersion: 2 });
    expect(assessment.reasons).toContain("corroborated_unknown_identity");
  });

  it.each([
    { domainAgeDays: null, genericTeamName: true },
    { domainAgeDays: null, verificationSeconds: 8 },
    { mx: "unknown" as const, verificationSeconds: 8 },
  ])(
    "sandboxes an unknown random identity before its first full key when corroborated: %j",
    (change) => {
      expect(assessSignupRisk(signals({ randomLocal: true, ...change })).level).toBe("sandbox");
      expect(assessSignupRisk(signals(change)).level).toBe("good");
    },
  );

  it.each([
    { domainAgeDays: null },
    { mx: "unknown" as const },
    { verificationSeconds: 8 },
    { genericTeamName: true },
    { domainAgeDays: null, mx: "unknown" as const, verificationSeconds: 8, genericTeamName: true },
  ])(
    "sandboxes a corroborated random identity and rapid full key without inventing a hold: %j",
    (change) => {
      expect(
        assessSignupRisk(signals({ randomLocal: true, rapidFullKey: true, ...change })).level,
      ).toBe("sandbox");
    },
  );

  it.each([0, -1, 15.001, Number.NaN, Number.POSITIVE_INFINITY, null])(
    "does not classify a mature identity from an unmeasured or nonrapid verification time: %s",
    (verificationSeconds) => {
      const assessment = assessSignupRisk(
        signals({ randomLocal: true, rapidFullKey: true, verificationSeconds }),
      );
      expect(assessment.level).toBe("good");
      expect(assessment.reasons).not.toContain("rapid_email_verification");
    },
  );

  it("requires corroborating identity and full-key evidence for a rapid verification or template team name", () => {
    expect(assessSignupRisk(signals({ verificationSeconds: 10 })).level).toBe("good");
    expect(assessSignupRisk(signals({ verificationSeconds: 8, rapidFullKey: true })).level).toBe(
      "good",
    );
    expect(
      assessSignupRisk(signals({ domainAgeDays: null, mx: "unknown", rapidFullKey: true })).level,
    ).toBe("good");
    expect(assessSignupRisk(signals({ randomLocal: true, genericTeamName: true })).level).toBe(
      "good",
    );
  });

  it.each([{ genericTeamName: true }, { domainAgeDays: null }, { mx: "unknown" as const }])(
    "sandboxes an opaque nonrandom identity only with both measured rapid events and corroboration: %j",
    (change) => {
      expect(
        assessSignupRisk(signals({ rapidFullKey: true, verificationSeconds: 15, ...change })).level,
      ).toBe("sandbox");
      expect(
        assessSignupRisk(signals({ rapidFullKey: true, verificationSeconds: 0, ...change })).level,
      ).toBe("good");
    },
  );

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
        policyVersion: 2,
      });
    },
  );
});
