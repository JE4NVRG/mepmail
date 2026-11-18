// @vitest-environment node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, it } from "vitest";

/**
 * The canary door's wiring, exercised against the real sources: the policy in
 * packages/config, the server-only digest module, the request adapter in
 * apps/web/src/server/signup-canary.ts, the closed-door authority and the two
 * better-auth hooks that consult it.
 *
 * No database and no network. The platform seams (env, config helpers,
 * next/headers, better-auth's APIError) are injected; the policy, the digest
 * comparison and every decision the door makes are the shipped code's own.
 * The end-to-end proof through Better Auth + PGlite is in
 * signup-canary-handler.test.ts.
 */
const root =
  process.env.MEPMAIL_CANARY_TEST_SOURCE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
/** Source with comments removed, so documentation may name what code must not do. */
const code = (name: string) =>
  source(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const deps = createRequire(import.meta.url);
const esbuild = createRequire(deps.resolve("vitest/config"))("esbuild");

const EMAIL = "qa.canary@mepmail.example";
const TOKEN = crypto.randomBytes(32).toString("base64url");
const DIGEST = crypto.createHash("sha256").update(TOKEN, "utf8").digest("hex");
const NOW = Date.now();
const COOKIE = "__Host-mepmail_canary_signup";

const ACTIVE = {
  MEPMAIL_CANARY_SIGNUP: true,
  MEPMAIL_CANARY_SIGNUP_EMAIL: EMAIL,
  MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: DIGEST,
  MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: new Date(NOW + 3_600_000).toISOString(),
  // The adapter requires the challenge to be configured as well as enforced.
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

/** The deployment shape every prerequisite-checked test starts from. */
const PREREQUISITES = {
  cloud: true,
  signupClosed: true,
  captchaEnforced: true,
  emailVerification: true,
};

class APIError extends Error {
  constructor(
    public status: string,
    public body: { message: string; code?: string },
  ) {
    super(body.message);
  }
}

type Resolver = (id: string) => unknown;

function compile(code: string, filename: string, resolve: Resolver): Record<string, unknown> {
  const compiled = esbuild.transformSync(code, {
    loader: "ts",
    format: "cjs",
    target: "es2023",
  }).code;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename })(
    resolve,
    module,
    module.exports,
  );
  return module.exports;
}

/** The inner text of the first block opened after `marker`, braces balanced. */
function block(text: string, marker: string): string {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `missing marker in source: ${marker}`);
  const open = text.indexOf("{", at + marker.length);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block after ${marker}`);
}

/** Compile the real request adapter with injected env, prerequisites and cookie jar. */
function loadAdapter(
  env: Record<string, unknown>,
  jar: Record<string, string> = {},
  prerequisites: Partial<typeof PREREQUISITES> = {},
) {
  const prereqs = { ...PREREQUISITES, ...prerequisites };
  const policy = compile(source("packages/config/src/canary-signup.ts"), "canary-signup.ts", () => {
    throw new Error("the policy module must stay dependency-free");
  });
  const tokenModule = compile(
    source("apps/web/src/server/canary-signup-token.ts"),
    "canary-signup-token.ts",
    (id) => {
      if (id === "server-only") return {};
      if (id === "node:crypto") return crypto;
      if (id === "@millionsend/config/canary-signup") return policy;
      throw new Error(`unexpected dependency ${id}`);
    },
  );
  const adapter = compile(
    source("apps/web/src/server/signup-canary.ts"),
    "signup-canary.ts",
    (id) => {
      if (id === "server-only") return {};
      if (id === "next/headers")
        return {
          cookies: async () => ({
            get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
          }),
        };
      if (id === "./canary-signup-token") return tokenModule;
      if (id === "./signup-bot-protection")
        return { signupBotProtectionEnabled: () => prereqs.captchaEnforced };
      if (id === "./system-mail")
        return { emailVerificationEnabled: () => prereqs.emailVerification };
      if (id === "@millionsend/config")
        return {
          env,
          isCloudDeployment: () => prereqs.cloud,
          signupOpen: () => !prereqs.signupClosed,
        };
      if (id === "@millionsend/config/canary-signup") return policy;
      throw new Error(`unexpected dependency ${id}`);
    },
  );
  return {
    policy,
    tokenModule,
    canarySignupSettingNow: () => (adapter.canarySignupSettingNow as () => unknown)(),
    canarySignupAdmissionFor: adapter.canarySignupAdmissionFor as (
      ctx: unknown,
      email: unknown,
    ) => { admitted: boolean; email?: string },
    canarySignupRenderAllowed: adapter.canarySignupRenderAllowed as () => Promise<boolean>,
  };
}

const AUTH = source("apps/web/src/server/auth.ts");
const SIGNUP_GUARD = 'if (ctx.path === "/sign-up/email")';
const SOCIAL_GUARD = 'if (ctx.path === "/sign-in/social" && signupBotProtectionEnabled())';
const CREATE_HOOK = "before: async (user, ctx) =>";

/** A compiled module exposing the `make(deps)` factory, with no project imports. */
function factory(code: string, filename: string) {
  return compile(code, filename, (id) => {
    throw new Error(`unexpected dependency ${id}`);
  }) as { make: (deps: Record<string, unknown>) => unknown };
}

/** Compile the `/sign-up/email` branch of the before hook around injected deps. */
function loadSignupBranch(depsIn: Record<string, unknown>) {
  return factory(
    `export function make(deps) {
  const { canarySignupAdmissionFor, assertSignupAllowed, signupOpen, signupBotProtectionEnabled, assertSignupBotVerification, verifiedSignupContexts, baseURL, db } = deps;
  return async (ctx) => { ${SIGNUP_GUARD} {${block(AUTH, SIGNUP_GUARD)}} };
}`,
    "signup-branch.ts",
  ).make(depsIn) as (ctx: unknown) => Promise<void>;
}

/** Compile the social branch: it must never consult the canary door. */
function loadSocialBranch(depsIn: Record<string, unknown>) {
  return factory(
    `export function make(deps) {
  const { canarySignupAdmissionFor, signupBotProtectionEnabled, assertSignupBotVerification, verifiedSignupContexts, addOAuthServerContext, SIGNUP_BOT_OAUTH_CONTEXT, baseURL } = deps;
  return async (ctx) => { ${SOCIAL_GUARD} {${block(AUTH, SOCIAL_GUARD)}} };
}`,
    "social-branch.ts",
  ).make(depsIn) as (ctx: unknown) => Promise<void>;
}

/** Compile the user.create before hook: the row-level authority. */
function loadUserCreateHook(depsIn: Record<string, unknown>) {
  return factory(
    `export function make(deps) {
  const { canarySignupAdmissionFor, assertSignupAllowed, signupOpen, signupBotProtectionEnabled, getOAuthState, verifiedSignupContexts, SIGNUP_BOT_OAUTH_CONTEXT, APIError, db } = deps;
  return async (user, ctx) => {${block(AUTH, CREATE_HOOK)}};
}`,
    "user-create-hook.ts",
  ).make(depsIn) as (user: { email: string }, ctx: unknown) => Promise<void>;
}

/* ---------------------------------------------------------------- authority */

let cap: number | undefined;
const assertion = compile(
  `import { APIError } from "better-auth/api";
import { betaMaxUsers } from "@millionsend/config";
const schema = { user: { id: "id" } };
${(() => {
  const at = AUTH.indexOf("export async function assertSignupAllowed(");
  assert.ok(at >= 0, "assertSignupAllowed must exist");
  const end = AUTH.indexOf("\n/**", at);
  assert.ok(end > at, "the authority must still be its own exported function");
  return AUTH.slice(at, end);
})()}`,
  "assertion.ts",
  (id) => {
    if (id === "better-auth/api") return { APIError };
    if (id === "@millionsend/config") return { betaMaxUsers: () => cap };
    throw new Error(`unexpected dependency ${id}`);
  },
).assertSignupAllowed as (
  db: unknown,
  allowSignup: boolean,
  canary?: { canaryEmail: string } | null,
) => Promise<void>;

function fakeDb(count: number) {
  const limits: number[] = [];
  return {
    limits,
    db: {
      select: () => ({
        from: () => ({
          limit: async (n: number) => {
            limits.push(n);
            return Array.from({ length: Math.min(count, n) }, (_, id) => ({ id: String(id) }));
          },
        }),
      }),
    },
  };
}

afterEach(() => {
  cap = undefined;
});

describe("assertSignupAllowed: one admission, no other exemptions", () => {
  it("refuses a closed instance that already has an account, with no admission", async () => {
    const { db } = fakeDb(1);
    await assert.rejects(() => assertion(db, false), { message: "Signup is disabled." });
    await assert.rejects(() => assertion(db, false, null), { message: "Signup is disabled." });
  });

  it("lets the canary admission through the closed-door check", async () => {
    const { db } = fakeDb(1);
    await assertion(db, false, { canaryEmail: EMAIL });
  });

  it("keeps the beta seat cap: the canary is not a limit exception", async () => {
    cap = 2;
    const { db } = fakeDb(2);
    await assert.rejects(() => assertion(db, false, { canaryEmail: EMAIL }), {
      message: "Beta is full.",
    });
  });

  it("leaves the bootstrap first account and an open instance unchanged", async () => {
    const first = fakeDb(0);
    await assertion(first.db, false, null);
    cap = 3;
    const open = fakeDb(2);
    await assertion(open.db, true, null);
    assert.deepEqual(open.limits, [3]);
  });
});

/* -------------------------------------------------------------- sign-up hook */

describe("the /sign-up/email hook opens the closed door for the canary only", () => {
  it("refuses a stranger with no cookie, and never reaches the challenge", async () => {
    const events: string[] = [];
    const run = loadSignupBranch({
      canarySignupAdmissionFor: loadAdapter(ACTIVE).canarySignupAdmissionFor,
      assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
        events.push(`authority:${canary ? "canary" : "closed"}`);
        throw new APIError("FORBIDDEN", { message: "Signup is disabled." });
      },
      signupOpen: () => false,
      signupBotProtectionEnabled: () => true,
      assertSignupBotVerification: async () => {
        events.push("turnstile");
      },
      verifiedSignupContexts: new WeakSet<object>(),
      baseURL: "https://app.mepmail.example",
      db: {},
    });
    await assert.rejects(
      () =>
        run({
          path: "/sign-up/email",
          headers: new Headers(),
          body: { email: EMAIL },
          context: {},
        }),
      { message: "Signup is disabled." },
    );
    assert.deepEqual(events, ["authority:closed"]);
  });

  it("admits the bound address with the operator cookie and still runs the challenge", async () => {
    const events: string[] = [];
    const run = loadSignupBranch({
      canarySignupAdmissionFor: loadAdapter(ACTIVE).canarySignupAdmissionFor,
      assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
        events.push(`authority:${canary ? "canary" : "closed"}`);
      },
      signupOpen: () => false,
      signupBotProtectionEnabled: () => true,
      assertSignupBotVerification: async () => {
        events.push("turnstile");
      },
      verifiedSignupContexts: new WeakSet<object>(),
      baseURL: "https://app.mepmail.example",
      db: {},
    });
    await run({
      path: "/sign-up/email",
      headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
      body: { email: EMAIL },
      context: {},
    });
    assert.deepEqual(events, ["authority:canary", "turnstile"]);
  });

  it("refuses the same cookie for any other address", async () => {
    const adapter = loadAdapter(ACTIVE);
    const admitted: unknown[] = [];
    const run = loadSignupBranch({
      canarySignupAdmissionFor: adapter.canarySignupAdmissionFor,
      assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
        admitted.push(canary ?? null);
      },
      signupOpen: () => false,
      signupBotProtectionEnabled: () => false,
      assertSignupBotVerification: async () => {},
      verifiedSignupContexts: new WeakSet<object>(),
      baseURL: "https://app.mepmail.example",
      db: {},
    });
    await run({
      path: "/sign-up/email",
      headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
      body: { email: "someone.else@mepmail.example" },
      context: {},
    });
    assert.deepEqual(admitted, [null]);
  });

  it("refuses an expired, disabled, partial or raw-token capability holding an exact cookie", async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...ACTIVE, MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: new Date(NOW - 60_000).toISOString() },
      { ...ACTIVE, MEPMAIL_CANARY_SIGNUP: false },
      { ...ACTIVE, MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: "" },
      { ...ACTIVE, MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: TOKEN },
      {
        ...ACTIVE,
        MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: new Date(NOW + 10 * 86_400_000).toISOString(),
      },
    ];
    for (const env of cases) {
      const adapter = loadAdapter(env);
      const admitted: unknown[] = [];
      const run = loadSignupBranch({
        canarySignupAdmissionFor: adapter.canarySignupAdmissionFor,
        assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
          admitted.push(canary ?? null);
        },
        signupOpen: () => false,
        signupBotProtectionEnabled: () => false,
        assertSignupBotVerification: async () => {},
        verifiedSignupContexts: new WeakSet<object>(),
        baseURL: "https://app.mepmail.example",
        db: {},
      });
      await run({
        path: "/sign-up/email",
        headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
        body: { email: EMAIL },
        context: {},
      });
      assert.deepEqual(admitted, [null], JSON.stringify(env));
    }
  });

  it("closes the door when any deployment prerequisite drifts", async () => {
    for (const [field, value] of [
      ["cloud", false],
      ["signupClosed", false],
      ["captchaEnforced", false],
      ["emailVerification", false],
    ] as const) {
      const adapter = loadAdapter(ACTIVE, {}, { [field]: value });
      const admitted: unknown[] = [];
      const run = loadSignupBranch({
        canarySignupAdmissionFor: adapter.canarySignupAdmissionFor,
        assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
          admitted.push(canary ?? null);
        },
        signupOpen: () => field === "signupClosed",
        signupBotProtectionEnabled: () => field !== "captchaEnforced",
        assertSignupBotVerification: async () => {},
        verifiedSignupContexts: new WeakSet<object>(),
        baseURL: "https://app.mepmail.example",
        db: {},
      });
      await run({
        path: "/sign-up/email",
        headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
        body: { email: EMAIL },
        context: {},
      });
      assert.deepEqual(admitted, [null], field);
    }
  });

  it("does not let the canary door swallow a failed Turnstile challenge", async () => {
    const events: string[] = [];
    const run = loadSignupBranch({
      canarySignupAdmissionFor: loadAdapter(ACTIVE).canarySignupAdmissionFor,
      assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
        events.push(`authority:${canary ? "canary" : "closed"}`);
      },
      signupOpen: () => false,
      signupBotProtectionEnabled: () => true,
      assertSignupBotVerification: async () => {
        events.push("turnstile");
        throw new APIError("FORBIDDEN", {
          message: "Complete the account verification and try again.",
        });
      },
      verifiedSignupContexts: new WeakSet<object>(),
      baseURL: "https://app.mepmail.example",
      db: {},
    });
    await assert.rejects(
      () =>
        run({
          path: "/sign-up/email",
          headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
          body: { email: EMAIL },
          context: {},
        }),
      { message: "Complete the account verification and try again." },
    );
    assert.deepEqual(events, ["authority:canary", "turnstile"]);
  });
});

/* -------------------------------------------------------------- social path */

describe("every other admission path ignores the canary", () => {
  it("never consults it on /sign-in/social, even with requestSignUp", async () => {
    const events: string[] = [];
    const run = loadSocialBranch({
      canarySignupAdmissionFor: () => {
        events.push("canary");
        return { admitted: true, email: EMAIL };
      },
      signupBotProtectionEnabled: () => true,
      assertSignupBotVerification: async () => {
        events.push("turnstile");
      },
      verifiedSignupContexts: new WeakSet<object>(),
      addOAuthServerContext: async (value: object) => {
        events.push(`context:${JSON.stringify(value)}`);
      },
      SIGNUP_BOT_OAUTH_CONTEXT: "mepmailSignupBotVerified",
      baseURL: "https://app.mepmail.example",
    });
    await run({
      path: "/sign-in/social",
      headers: new Headers({ "x-captcha-response": "token" }),
      body: { requestSignUp: true },
      context: {},
    });
    assert.deepEqual(events, ["turnstile", 'context:{"mepmailSignupBotVerified":true}']);
  });
});

/* ---------------------------------------------------------- user.create hook */

describe("user.create re-derives the proof from the request that creates the row", () => {
  function createHarness(options: {
    env?: Record<string, unknown>;
    ctx?: unknown;
    bot?: boolean;
    verified?: boolean;
    prerequisites?: Partial<typeof PREREQUISITES>;
  }) {
    const events: string[] = [];
    const adapter = loadAdapter(options.env ?? ACTIVE, {}, options.prerequisites);
    const verifiedSignupContexts = new WeakSet<object>();
    const ctxContext = { request: "in-flight" };
    if (options.verified) verifiedSignupContexts.add(ctxContext);
    const run = loadUserCreateHook({
      canarySignupAdmissionFor: adapter.canarySignupAdmissionFor,
      assertSignupAllowed: async (_db: unknown, _allow: boolean, canary?: unknown) => {
        events.push(
          `authority:${canary ? (canary as { canaryEmail: string }).canaryEmail : "closed"}`,
        );
      },
      signupOpen: () => false,
      signupBotProtectionEnabled: () => options.bot === true,
      getOAuthState: async () => undefined,
      verifiedSignupContexts,
      SIGNUP_BOT_OAUTH_CONTEXT: "mepmailSignupBotVerified",
      APIError,
      db: {},
    });
    return {
      events,
      run: (email: string) =>
        run(
          { email },
          options.ctx === undefined
            ? {
                path: "/sign-up/email",
                headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
                context: ctxContext,
              }
            : options.ctx,
        ),
    };
  }

  it("passes the admission for the row's own address", async () => {
    const { events, run } = createHarness({});
    await run(EMAIL);
    assert.deepEqual(events, [`authority:${EMAIL}`]);
  });

  it("binds it to the address being created, not to the cookie alone", async () => {
    const { events, run } = createHarness({});
    await run("attacker@mepmail.example");
    assert.deepEqual(events, ["authority:closed"]);
  });

  it("refuses a social request and a missing context", async () => {
    const social = createHarness({
      ctx: {
        path: "/sign-in/social",
        headers: new Headers({ cookie: `${COOKIE}=${TOKEN}` }),
        context: {},
      },
    });
    await social.run(EMAIL);
    assert.deepEqual(social.events, ["authority:closed"]);

    const missing = createHarness({ ctx: null });
    await missing.run(EMAIL);
    assert.deepEqual(missing.events, ["authority:closed"]);
  });

  it("still demands the Turnstile proof for an admitted canary account", async () => {
    const { run } = createHarness({ bot: true });
    await assert.rejects(() => run(EMAIL), { message: /account verification/i });

    const verified = createHarness({ bot: true, verified: true });
    await verified.run(EMAIL);
    assert.deepEqual(verified.events, [`authority:${EMAIL}`]);
  });

  it("keeps an expired canary closed on this path too", async () => {
    const { events, run } = createHarness({
      env: { ...ACTIVE, MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: new Date(NOW - 1).toISOString() },
    });
    await run(EMAIL);
    assert.deepEqual(events, ["authority:closed"]);
  });

  it("keeps a drifted deployment closed on this path too", async () => {
    const { events, run } = createHarness({ prerequisites: { emailVerification: false } });
    await run(EMAIL);
    assert.deepEqual(events, ["authority:closed"]);
  });
});

/* --------------------------------------------------------------------- render */

describe("the /signup render follows the same cookie and nothing more", () => {
  it("renders only for the operator's own cookie", async () => {
    const { canarySignupRenderAllowed } = loadAdapter(ACTIVE, { [COOKIE]: TOKEN });
    assert.equal(await canarySignupRenderAllowed(), true);
  });

  it("does not render for a missing or wrong cookie, or a closed capability", async () => {
    const missing = loadAdapter(ACTIVE, {});
    assert.equal(await missing.canarySignupRenderAllowed(), false);
    const wrong = loadAdapter(ACTIVE, { [COOKIE]: `${TOKEN}0` });
    assert.equal(await wrong.canarySignupRenderAllowed(), false);
    const off = loadAdapter({ ...ACTIVE, MEPMAIL_CANARY_SIGNUP: false }, { [COOKIE]: TOKEN });
    assert.equal(await off.canarySignupRenderAllowed(), false);
    const expired = loadAdapter(
      { ...ACTIVE, MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: new Date(NOW - 1).toISOString() },
      { [COOKIE]: TOKEN },
    );
    assert.equal(await expired.canarySignupRenderAllowed(), false);
  });

  it("does not render when the deployment premises no longer hold", async () => {
    for (const [field, value] of [
      ["cloud", false],
      ["signupClosed", false],
      ["captchaEnforced", false],
      ["emailVerification", false],
    ] as const) {
      const { canarySignupRenderAllowed } = loadAdapter(
        ACTIVE,
        { [COOKIE]: TOKEN },
        {
          [field]: value,
        },
      );
      assert.equal(await canarySignupRenderAllowed(), false, field);
    }
  });

  it("never turns the cookie into a full setting: a raw token cannot be configured", async () => {
    const { canarySignupSettingNow } = loadAdapter({
      ...ACTIVE,
      MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: TOKEN,
    });
    assert.equal((canarySignupSettingNow() as { status: string }).status, "invalid");
  });
});

/* --------------------------------------------------------------- invariants */

describe("the digest binding and the guards the canary must not weaken", () => {
  it("keeps the policy free of Node builtins, hashing and I/O", () => {
    const policy = code("packages/config/src/canary-signup.ts");
    // No imports at all (the module is reached only through its own subpath),
    // no hashing, no I/O, no logging.
    assert.doesNotMatch(policy, /^\s*import\s/m);
    assert.doesNotMatch(policy, /require\(/);
    assert.doesNotMatch(policy, /createHash|createHmac|timingSafeEqual/);
    assert.doesNotMatch(policy, /console\./);
    assert.doesNotMatch(policy, /fetch\(|process\.env/);
  });

  it("compares the token in exactly one server-only module, with node:crypto", () => {
    const token = source("apps/web/src/server/canary-signup-token.ts");
    assert.match(token, /^import "server-only";/m);
    assert.match(token, /import \{ createHash, timingSafeEqual \} from "node:crypto";/);
    assert.match(token, /timingSafeEqual\(actual, expected\)/);
    // No hand-rolled constant-time loop anywhere in the door.
    for (const name of [
      "packages/config/src/canary-signup.ts",
      "apps/web/src/server/canary-signup-token.ts",
      "apps/web/src/server/signup-canary.ts",
    ]) {
      assert.doesNotMatch(source(name), /charCodeAt|SECRET_COMPARE_ROUNDS/, name);
    }
  });

  it("never logs or URL-encodes the token", () => {
    for (const name of [
      "apps/web/src/server/canary-signup-token.ts",
      "apps/web/src/server/signup-canary.ts",
      "apps/web/src/app/signup/page.tsx",
    ]) {
      const text = source(name);
      assert.doesNotMatch(text, /console\./, name);
      assert.doesNotMatch(text, /searchParams\.set|URLSearchParams|encodeURIComponent/, name);
    }
  });

  it("keeps the canary out of the boot checks and out of the config barrel", () => {
    const env = source("packages/config/src/env.ts");
    // The schema DECLARES the variables; nothing may consult the policy there.
    assert.doesNotMatch(code("packages/config/src/env.ts"), /from "\.\/canary-signup/);
    const consistency = block(env, "export function assertEnvConsistency(e: Env): void")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(consistency, /canary/i);
    const index = code("packages/config/src/index.ts");
    assert.doesNotMatch(index, /canary/i);
  });

  it("keeps one account per address, which is what bounds the sign-up race", () => {
    const schema = source("packages/db/src/schema/auth.ts");
    assert.match(schema, /email: text\("email"\)\.notNull\(\)\.unique\(\)/);
  });

  it("leaves publicSignupAvailability on the ordinary authority", () => {
    const availability = source("apps/web/src/server/public-signup.ts");
    assert.match(availability, /assertSignupAllowed\(getDb\(\), signupOpen\(\)\)/);
    assert.doesNotMatch(availability, /canary/i);
  });

  it("consults the canary door in exactly the two admission points", () => {
    const occurrences = AUTH.match(/canarySignupAdmissionFor\(/g) ?? [];
    assert.equal(occurrences.length, 2, "one per admission point");
    assert.match(AUTH, /const canary = canarySignupAdmissionFor\(ctx, body\?\.email\);/);
    assert.match(AUTH, /const canary = canarySignupAdmissionFor\(ctx, user\.email\);/);
  });

  it("renders the canary form only in the paused state, never cached", () => {
    const page = source("apps/web/src/app/signup/page.tsx");
    assert.match(page, /export const dynamic = "force-dynamic";/);
    assert.match(
      page,
      /const canary = availability === "paused" && \(await canarySignupRenderAllowed\(\)\);/,
    );
    assert.doesNotMatch(page, /availability !== "open" && \(await canarySignupRenderAllowed/);
  });
});
