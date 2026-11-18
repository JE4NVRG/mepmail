import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANARY_SIGNUP_COOKIE,
  CANARY_SIGNUP_MAX_TTL_MS,
  CANARY_SIGNUP_NO_PREREQUISITES,
  CANARY_SIGNUP_PATH,
  CANARY_SIGNUP_TOKEN_LENGTH,
  type CanarySignupPrerequisites,
  canarySignupAdmission,
  canarySignupCookieValid,
  canarySignupDigestShape,
  canarySignupSetting,
  canarySignupTokenShape,
  normalizeCanaryEmail,
  readCookieValue,
} from "../src/canary-signup.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const TOKEN = randomBytes(32).toString("base64url");
const DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const EMAIL = "qa.canary@mepmail.example";

/** The deployment shape the door is allowed to exist in. */
const PREREQUISITES: CanarySignupPrerequisites = {
  cloud: true,
  signupClosed: true,
  captchaEnforced: true,
  emailVerification: true,
};

const active = {
  enabled: true,
  email: EMAIL,
  tokenDigest: DIGEST,
  expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
} as const;

const at = (ms: number) => new Date(ms).toISOString();
const setting = (fields: Record<string, unknown>, prereqs = PREREQUISITES, now = NOW) =>
  canarySignupSetting(fields, prereqs, now, now);
/** The same comparison the server-only module performs, for the matrix only. */
const verify = (presented: string, digest: string) =>
  createHash("sha256").update(presented, "utf8").digest("hex") === digest;

describe("off is off, and nothing else has to be removed", () => {
  it("is disabled with nothing set", () => {
    expect(setting({})).toEqual({ status: "disabled" });
    expect(setting({ enabled: false })).toEqual({ status: "disabled" });
    expect(setting({ enabled: "false", email: "", tokenDigest: "", expiresAt: "" })).toEqual({
      status: "disabled",
    });
  });

  it("is disabled by the switch alone, with every auxiliary value still set", () => {
    // The rollback path: one variable, no coordinated cleanup.
    for (const enabled of [false, "false", "0", undefined, null, ""]) {
      expect(setting({ ...active, enabled }), String(enabled)).toEqual({ status: "disabled" });
    }
  });

  it("is disabled even when the auxiliary values are themselves broken", () => {
    expect(
      setting({ enabled: false, email: "not-an-address", tokenDigest: "x", expiresAt: "soon" }),
    ).toEqual({ status: "disabled" });
  });
});

describe("a switched-on door must be complete and well-formed", () => {
  const partial: Array<Record<string, unknown>> = [
    {},
    { email: EMAIL },
    { tokenDigest: DIGEST },
    { expiresAt: active.expiresAt },
    { email: EMAIL, tokenDigest: DIGEST },
    { email: EMAIL, expiresAt: active.expiresAt },
    { tokenDigest: DIGEST, expiresAt: active.expiresAt },
    { email: "   ", tokenDigest: DIGEST, expiresAt: active.expiresAt },
  ];
  for (const fields of partial) {
    it(`refuses a partial configuration: ${Object.keys(fields).join("+") || "nothing"}`, () => {
      const result = setting({ enabled: true, ...fields });
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" && result.message).toMatch(/together|one bare address/);
    });
  }

  it("refuses an address list, a display name, or anything that is not ONE bare address", () => {
    for (const email of [
      "qa@example.com,other@example.com",
      "QA <qa@example.com>",
      "qa@example",
      "qa example@example.com",
      "qa@example.com;other@example.com",
      "qa@example.com\nother@example.com",
    ]) {
      expect(setting({ ...active, email }).status).toBe("invalid");
    }
  });

  it("accepts only a canonical SHA-256 digest as the secret material", () => {
    const rejected = [
      // The bearer itself: putting the token back into the environment is the
      // mistake this whole shape exists to prevent.
      TOKEN,
      // Padded / non-canonical hex, wrong lengths, foreign alphabet.
      `${DIGEST}=`,
      DIGEST.toUpperCase(),
      DIGEST.slice(0, 63),
      `${DIGEST}0`,
      `0x${DIGEST.slice(2)}`,
      DIGEST.replace(/^./, "g"),
    ];
    for (const tokenDigest of rejected) {
      const result = setting({ ...active, tokenDigest });
      expect(result.status, String(tokenDigest).slice(0, 12)).toBe("invalid");
      expect(result.status === "invalid" && result.message).toMatch(/never the token itself/);
    }
    // An empty digest is a missing value, not a malformed one.
    const empty = setting({ ...active, tokenDigest: "" });
    expect(empty.status === "invalid" && empty.message).toMatch(/_TOKEN_SHA256 and _EXPIRES_AT/);
    // Surrounding whitespace from a shell assignment is tolerated, the value is not rewritten.
    expect(setting({ ...active, tokenDigest: ` ${DIGEST} ` }).status).toBe("active");
  });

  it("refuses a local-time or otherwise non-absolute expiry", () => {
    for (const expiresAt of [
      "2026-11-18T13:00:00",
      "18/11/2026 13:00",
      "next week",
      "2026-11-18T13:00:00-03:00",
      `${active.expiresAt}x`,
    ]) {
      expect(setting({ ...active, expiresAt }).status).toBe("invalid");
    }
  });

  it("keeps the door short-lived: farther than 72h from process start is a misconfiguration", () => {
    const far = at(NOW + CANARY_SIGNUP_MAX_TTL_MS + 60_000);
    expect(setting({ ...active, expiresAt: far }).status).toBe("invalid");
    const edge = at(NOW + CANARY_SIGNUP_MAX_TTL_MS);
    expect(setting({ ...active, expiresAt: edge }, PREREQUISITES, NOW).status).toBe("active");
    // A process that started before the ceiling was measured refuses it too.
    expect(
      canarySignupSetting({ ...active, expiresAt: edge }, PREREQUISITES, NOW, NOW - 60_000).status,
    ).toBe("invalid");
  });

  it("closes itself at the expiry instant", () => {
    expect(setting({ ...active, expiresAt: at(NOW) }).status).toBe("expired");
    expect(setting({ ...active, expiresAt: at(NOW - 1) }).status).toBe("expired");
    expect(setting({ ...active, expiresAt: at(NOW + 1) }).status).toBe("active");
  });
});

describe("the door only exists in the deployment shape it was written for", () => {
  it("is active only with all four prerequisites", () => {
    expect(setting(active)).toMatchObject({ status: "active" });
  });

  const dropped: Array<[keyof CanarySignupPrerequisites, RegExp]> = [
    ["cloud", /IS_CLOUD=true/],
    ["signupClosed", /ALLOW_SIGNUP=false/],
    ["captchaEnforced", /SIGNUP_BOT_PROTECTION=true with TURNSTILE_SITE_KEY/],
    ["emailVerification", /AUTH_EMAIL_FROM/],
  ];
  for (const [field, message] of dropped) {
    it(`is blocked when ${field} no longer holds, with the exact configuration`, () => {
      const result = setting(active, { ...PREREQUISITES, [field]: false });
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" && result.message).toMatch(message);
      // Inert, and never a thrown error: the boot of every other role is safe.
      expect(result.status === "blocked" && result.message).toMatch(/stays closed until/);
    });
  }

  it("names every missing prerequisite at once", () => {
    const result = setting(active, CANARY_SIGNUP_NO_PREREQUISITES);
    expect(result.status).toBe("blocked");
    const message = result.status === "blocked" ? result.message : "";
    expect(message).toMatch(/IS_CLOUD=true/);
    expect(message).toMatch(/ALLOW_SIGNUP=false/);
    expect(message).toMatch(/SIGNUP_BOT_PROTECTION=true/);
    expect(message).toMatch(/e-mail verification/);
  });

  it("fails closed when a caller states no prerequisites at all", () => {
    expect(canarySignupSetting(active).status).toBe("blocked");
    expect(canarySignupSetting(active, undefined, NOW, NOW).status).toBe("blocked");
  });

  it("reports a configuration mistake before an inapplicable deployment", () => {
    // Order is part of the contract: fix the fields first, then the premises.
    const result = setting({ ...active, tokenDigest: TOKEN }, CANARY_SIGNUP_NO_PREREQUISITES);
    expect(result.status).toBe("invalid");
  });

  it("is disabled, not blocked, when switched off on a self-host", () => {
    expect(
      canarySignupSetting({ ...active, enabled: false }, CANARY_SIGNUP_NO_PREREQUISITES, NOW, NOW),
    ).toEqual({ status: "disabled" });
  });
});

describe("the admission matrix", () => {
  const adm = (input: { path?: string; email?: unknown; cookie?: string | null }) =>
    canarySignupAdmission(
      {
        path: "path" in input && input.path !== undefined ? input.path : CANARY_SIGNUP_PATH,
        // `null`/`undefined` are cases of their own here, not "use the default".
        email: "email" in input ? input.email : EMAIL,
        cookie: "cookie" in input ? (input.cookie ?? null) : TOKEN,
      },
      setting(active),
      verify,
    );

  it("admits exactly the bound address on the password endpoint with the operator token", () => {
    expect(adm({})).toEqual({ admitted: true, email: EMAIL });
    expect(adm({ email: "  QA.Canary@MepMail.Example " })).toEqual({
      admitted: true,
      email: EMAIL,
    });
  });

  it("denies every other address, including one that only differs", () => {
    for (const email of [
      "other@mepmail.example",
      "qa.canary@mepmail.example.br",
      "qa.canary+1@mepmail.example",
      "qa.canary@mepmail.exampl",
      "",
      null,
      undefined,
      42,
      { email: EMAIL },
    ]) {
      expect(adm({ email })).toEqual({ admitted: false });
    }
  });

  it("denies a missing, wrong, extended, truncated or encoded token", () => {
    for (const cookie of [
      null,
      "",
      "wrong",
      TOKEN.slice(0, -1),
      `${TOKEN}x`,
      `${TOKEN}=`,
      ` ${TOKEN}`,
      DIGEST,
      Buffer.from(TOKEN).toString("base64"),
    ]) {
      expect(adm({ cookie }), String(cookie).slice(0, 12)).toEqual({ admitted: false });
    }
  });

  it("denies every path but the password sign-up endpoint", () => {
    for (const path of [
      "/sign-in/social",
      "/sign-in/email",
      "/sign-up/email/",
      "/sign-up",
      "/api/auth/sign-up/email",
      "",
    ]) {
      expect(adm({ path })).toEqual({ admitted: false });
    }
  });

  const inactive: Array<[string, ReturnType<typeof setting>]> = [
    ["disabled", setting({})],
    ["blocked", setting(active, { ...PREREQUISITES, cloud: false })],
    ["invalid", setting({ enabled: true, email: EMAIL })],
    ["expired", setting({ ...active, expiresAt: at(NOW - 1) })],
  ];
  for (const [name, inactiveSetting] of inactive) {
    it(`denies a ${name} capability even with the exact address and token`, () => {
      expect(
        canarySignupAdmission(
          { path: CANARY_SIGNUP_PATH, email: EMAIL, cookie: TOKEN },
          inactiveSetting,
          verify,
        ),
      ).toEqual({ admitted: false });
    });
  }

  it("denies when the caller brought no verifier", () => {
    for (const verifyCookie of [undefined, null]) {
      expect(
        canarySignupAdmission(
          { path: CANARY_SIGNUP_PATH, email: EMAIL, cookie: TOKEN },
          setting(active),
          verifyCookie,
        ),
      ).toEqual({ admitted: false });
    }
  });

  it("still requires the address when the verifier accepts everything", () => {
    const permissive = () => true;
    expect(
      canarySignupAdmission(
        { path: CANARY_SIGNUP_PATH, email: "other@mepmail.example", cookie: TOKEN },
        setting(active),
        permissive,
      ),
    ).toEqual({ admitted: false });
    expect(
      canarySignupAdmission(
        { path: "/sign-in/social", email: EMAIL, cookie: TOKEN },
        setting(active),
        permissive,
      ),
    ).toEqual({ admitted: false });
  });

  it("keeps the cookie-only answer for the render on the same setting", () => {
    expect(canarySignupCookieValid(TOKEN, setting(active), verify)).toBe(true);
    for (const cookie of [null, "", "wrong", `${TOKEN}x`]) {
      expect(canarySignupCookieValid(cookie, setting(active), verify)).toBe(false);
    }
    expect(canarySignupCookieValid(TOKEN, setting({}), verify)).toBe(false);
    expect(
      canarySignupCookieValid(TOKEN, setting(active, { ...PREREQUISITES, cloud: false }), verify),
    ).toBe(false);
  });
});

describe("shapes and cookie parsing, without trusting the request", () => {
  it("finds the value among other cookies, by exact name only", () => {
    expect(readCookieValue(`${CANARY_SIGNUP_COOKIE}=${TOKEN}`, CANARY_SIGNUP_COOKIE)).toBe(TOKEN);
    expect(
      readCookieValue(`a=1; ${CANARY_SIGNUP_COOKIE}=${TOKEN}; b=2`, CANARY_SIGNUP_COOKIE),
    ).toBe(TOKEN);
    expect(readCookieValue(`x${CANARY_SIGNUP_COOKIE}=no`, CANARY_SIGNUP_COOKIE)).toBeNull();
    expect(readCookieValue(`a=1; b=2`, CANARY_SIGNUP_COOKIE)).toBeNull();
    expect(readCookieValue("garbage", CANARY_SIGNUP_COOKIE)).toBeNull();
    expect(readCookieValue(null, CANARY_SIGNUP_COOKIE)).toBeNull();
    expect(readCookieValue("", CANARY_SIGNUP_COOKIE)).toBeNull();
  });

  it("accepts only the 43-character base64url token shape", () => {
    expect(CANARY_SIGNUP_TOKEN_LENGTH).toBe(43);
    expect(TOKEN).toHaveLength(43);
    expect(canarySignupTokenShape(TOKEN)).toBe(true);
    for (const value of [
      TOKEN.slice(1),
      `${TOKEN}A`,
      `${TOKEN}=`,
      `${TOKEN.slice(0, 42)}+`,
      `${TOKEN.slice(0, 42)}/`,
      ` ${TOKEN}`,
      "",
      null,
      undefined,
      123,
    ]) {
      expect(canarySignupTokenShape(value), String(value).slice(0, 12)).toBe(false);
    }
  });

  it("accepts only the canonical digest shape", () => {
    expect(canarySignupDigestShape(DIGEST)).toBe(true);
    for (const value of [DIGEST.toUpperCase(), TOKEN, `${DIGEST}0`, DIGEST.slice(1), null]) {
      expect(canarySignupDigestShape(value), String(value).slice(0, 12)).toBe(false);
    }
  });

  it("normalizes exactly like the stored address", () => {
    expect(normalizeCanaryEmail(" QA@Example.COM ")).toBe("qa@example.com");
    expect(normalizeCanaryEmail(undefined)).toBe("");
    expect(normalizeCanaryEmail(null)).toBe("");
    expect(normalizeCanaryEmail(["qa@example.com"])).toBe("");
  });
});
