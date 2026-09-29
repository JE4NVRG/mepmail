# Landing CRO — local preview and publication boundary

## Environment

Reuse `F:\MepMail` on Windows and the existing `feat/launch-readiness` checkout. Do not copy `.env`, production data, node_modules or secrets from the server. Pre-existing Windows source WIP is recoverable at `F:\MepMail\.local-wip-preserved\cro-base\manifest.json`; the original 15 files were verified byte-for-byte before source alignment. These copies are not disposable build cache.

## Validation commands (PowerShell, existing Windows dependencies)

At the repository root, use `NODE_ENV=test` for tests and execute Biome on the changed TS/TSX/JSON/CSS files. In `apps\web`:

    $env:NODE_ENV='test'
    pnpm.cmd exec vitest run test/landing-cro.test.ts test/i18n-parity.test.ts test/value-positioning.test.ts test/landing-savings.test.ts test/public-funnel.test.ts test/funnel-env-gate.test.ts test/footer-claims.test.ts test/stack-logos.test.ts
    pnpm.cmd exec tsc --noEmit

For the native build, use `pnpm.cmd exec next build --webpack` with `NODE_ENV=production`, `SKIP_ENV_VALIDATION=1` and the same local-preview environment as the server. The package's POSIX inline-env build script is not a PowerShell command.

## Preview server

Only after a successful build, with no server using the same `.next` directory:

    $env:NODE_ENV='production'
    $env:SKIP_ENV_VALIDATION='1'
    $env:MEPMAIL_LOCAL_PREVIEW='1'
    $env:UMAMI_ENDPOINT=''
    $env:UMAMI_WEBSITE_ID=''
    $env:APP_BASE_URL='http://127.0.0.1:9897'
    $env:API_BASE_URL='http://127.0.0.1:9897'
    $env:DATABASE_URL='postgresql://preview:preview@127.0.0.1:1/preview'
    $env:BETTER_AUTH_SECRET='local-preview-only-not-a-real-secret-0000'
    $env:IS_CLOUD='false'
    node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 9897

The dummy database deliberately points to an unavailable local port. Anonymous landing rendering requires no database; do not submit auth forms. `MEPMAIL_LOCAL_PREVIEW=1` omits the production Umami script; clearing both server collector variables prevents server-side emission. Keep this flag out of production.

Use a tracked process with dedicated stdout/stderr logs and a PID manifest. Confirm HTTP 200 plus the new EN/PT H1 before screenshots. Stop only that verified preview PID before rebuilding. QA via another host may use a loopback-only SSH tunnel; a disconnected tunnel is not evidence the Windows server stopped.

## Publication

This task authorizes local preview only. No push, PR, production merge or deployment is part of the delivery. Jean must approve after independent QA and Luna's visual review. A future authorized release should publish only the validated artifact and verify served SHA and affected journeys under the shared local-first delivery standard.
