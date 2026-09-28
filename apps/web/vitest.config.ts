import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Page/component tests import .tsx; Next compiles with the automatic runtime.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    hookTimeout: 60_000,
    // DB-backed tests run migrations + PGlite in the test BODY, so the vitest default of 5s
    // (not the hookTimeout above) is what actually applies here — measured on je4ndev-ci
    // (card t_bb67c499, 2026-09-28): with the VPS at 2.1% CPU idle / ldavg-1 42 / runq 43
    // the same tests inflated 1.7–2.3x (oauth-provider file 128s -> 292s) and 4 of them
    // crossed 5s, failing with "Test timed out in 5000ms" while the very same commit passed
    // green 1h later. apps/db, packages/core and packages/cli already pin testTimeout: 60_000
    // for the same reason (packages/db says it outright: migrations run inside the test body).
    testTimeout: 60_000,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // SKIP_ENV_VALIDATION: tests stub the variables they need, so the schema
    // must not demand a full production environment.
    //
    // The Umami pair is pinned empty on purpose (card t_47d43fde): the web
    // suite is what emitted real `signup`/`checkout_started` events into the
    // hosted collector — many of its files stub IS_CLOUD=true, and the server
    // used to read that toggle as "report to the JE4NDEV Umami". A test run
    // must never report into whichever collector the shell happens to export;
    // suites that exercise the emission path (test/funnel-env-gate.test.ts)
    // stub the pair themselves.
    env: { SKIP_ENV_VALIDATION: "1", UMAMI_ENDPOINT: "", UMAMI_WEBSITE_ID: "" },
  },
});
