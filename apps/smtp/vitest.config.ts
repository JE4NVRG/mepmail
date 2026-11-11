import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners,
    // and some tests write whole mailboxes in their body (like packages/core and apps/web).
    hookTimeout: 60_000,
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    env: {
      SKIP_ENV_VALIDATION: "1",
      // A test run must never answer DNS for real: the accept pipeline's
      // recipient-domain gate is on in production and resolves MX over the
      // network. Suites that exercise the gate stub the resolver and set
      // RECIPIENT_DOMAIN_CHECK=on themselves (packages/core/accept-email.test.ts).
      RECIPIENT_DOMAIN_CHECK: "off",
    },
  },
});
