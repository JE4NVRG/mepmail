/**
 * Vitest stand-in for the `server-only` marker.
 *
 * `server-only` is a build-time marker: Next.js aliases it while compiling the
 * server graph and the app never depends on the package itself (it is not in
 * any package.json — see pnpm-lock). Under plain Node, importing it throws
 * "Cannot find package 'server-only'", which would make every suite that
 * transitively imports a server module fail before its first assertion.
 *
 * Aliasing it to an empty module in vitest.config.ts keeps that guard in the
 * production build while letting the PGlite/HTTP suites import the real
 * `src/server/*` sources. It intentionally exports nothing.
 */
export {};
