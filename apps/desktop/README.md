# MepMail Correio for the desktop

The Windows app for Correio, built with Tauri 2: a small Rust shell around
WebView2. The same shell is the base for macOS, Linux, iOS and Android.

## What version 0.1 does

- Opens a native window on a bundled splash page (`src/`), checks that
  mepmail.dev answers, then loads <https://mepmail.dev/mail>. The hosted app
  is the UI, so every web release reaches the desktop at once.
- One instance: launching the app again focuses the open window.
- Tray icon: a left click opens the window; the menu offers Open and Quit
  (Portuguese or English, from the system locale).
- Window size and position are remembered between launches.
- Navigation guard: the webview stays on mepmail.dev and on the Google
  sign-in hosts (accounts.google.com, accounts.youtube.com,
  myaccount.google.com; never a `.google.com` suffix, so a Docs or Meet link
  in an email opens outside). Everything else opens in the system browser:
  Stripe Checkout, the docs, links inside emails, `target="_blank"`.
  `mailto:` links go to the system mail client for now; `cursor://` (the
  dashboard's "Open in Cursor") is the only other scheme handed to the OS.
- The window appears once the splash has painted (a 3 s safety net shows it
  regardless); the window-state plugin restores placement, never visibility.
- Every page gets `window.__MEPMAIL_DESKTOP__ = { app, version, platform }`
  and `<html data-mepmail-desktop="0.1.0">`, so the web app can adapt without
  sniffing the user agent.
- Dark title bar, black background behind the page (no white flash),
  Ctrl +/- zoom.

## What 0.2 adds

- Tray menu: "Iniciar com o Windows" (autostart plugin, the entry launches the
  app with `--minimized`, which keeps the window in the tray) and "Manter na
  bandeja ao fechar" (the X hides the window; "Sair" quits). Preferences live
  in `%APPDATA%\dev.mepmail.correio\settings.json`.
- Unread badge: the hosted app mirrors "(N) Correio · MepMail" into the window
  title; the shell reads it every 3 s and shows a taskbar overlay dot plus a
  tray tooltip "N não lidas".
- `mepmail://` deep links: `mepmail://mail[/path?query]` and `mepmail://open`
  bring the window to that page (installer registers the scheme; a debug build
  registers it itself). A second launch with a link hands it to the running
  instance.
- Agents bridge: `mepmail-correio.exe --mcp --mailbox <id>` is a stdio MCP
  server that forwards every JSON-RPC message to
  `https://api.mepmail.dev/mcp/correio` with the mailbox's `mmb_` key from the
  Windows credential vault (`MEPMAIL_AGENT_KEY` overrides it, for tests;
  `MEPMAIL_CORREIO_MCP_URL` overrides the endpoint). Session id, SSE answers
  and 202 notifications are handled; errors come back as JSON-RPC errors.
- Agent commands the hosted page may call through the IPC:
  `store_agent_key(mailboxId, token)`, `has_agent_key(mailboxId)`,
  `forget_agent_key(mailboxId)` and `install_agent(target, mailboxId,
  serverName?)` with targets `claude-desktop` (writes
  `%APPDATA%\Claude\claude_desktop_config.json`), `cursor`
  (`~/.cursor/mcp.json`), `claude-code` (`claude mcp add … -- <exe> --mcp
  --mailbox <id>`) and `codex` (`codex mcp add …`). Every entry points at this
  executable; no key is written anywhere. `store_agent_key` and
  `install_agent` first ask the user in a native dialog (target, mailbox and
  server name spelled out) and validate every value (UUID mailbox id,
  `[a-z0-9-]` server name, `mmb_` token, fixed targets); CLI arguments go as
  a list. A script injected into the hosted page cannot plant a config. The commands are declared in
  `build.rs` (`AppManifest::commands`), which is what lets the capability
  grant them to the remote origin as `allow-<command>`.

## What 0.3 adds

- Signed self-updates (`src/update.rs`, `tauri-plugin-updater`). The shell
  reads `https://mepmail.dev/desktop/correio/latest.json` 20 s after start and
  every 6 h; the tray has "Procurar atualizações". A newer version is offered
  in a native dialog ("Atualizar agora" / "Depois"). Yes downloads the
  installer, checks its minisign signature against `plugins.updater.pubkey`
  and runs it in passive mode; the app closes and reopens on the new version.
  "Depois" silences background offers of that version until the next start.
  An update found while the window sits hidden in the tray waits until the
  window gets focus. Nothing installs without a yes.
- HTML drag and drop reaches the page (`disable_drag_drop_handler`): drag a
  message onto a folder, or a file onto the composer, as in a browser tab.
- The web app offers the download in the Correio account menu ("App para
  Windows", Windows browsers only); the stable link is
  `https://mepmail.dev/desktop/correio/windows`.

## Layout

- `src/`: the splash page. Static HTML, CSS and JS, no build step.
- `src-tauri/src/lib.rs`: all shell behaviour (window, guard, tray, plugins).
- `src-tauri/tauri.conf.json`: product name, identifier `dev.mepmail.correio`,
  CSP of the splash page, NSIS installer settings.
- `src-tauri/capabilities/main.json`: what pages on mepmail.dev and
  www.mepmail.dev may call through the Tauri IPC: events, the window title
  and notifications, nothing else.
- `src-tauri/icons/`: generated from `apps/web/public/logo/mepmail-favicon.svg`
  with `npm run icons`.

This folder is not a pnpm workspace member (`pnpm-workspace.yaml` excludes
it) and never enters the server image (`.dockerignore`): it has its own npm
lockfile and a Rust toolchain the server build does not need.

## Toolchain on Windows

1. Rust through rustup, MSVC host (`winget install --id Rustlang.Rustup`).
   Installed on 2026-10-08: stable-x86_64-pc-windows-msvc 1.99.
2. Microsoft C++ Build Tools with the "Desktop development with C++"
   workload (MSVC v143 and the Windows SDK). The installer needs an
   administrator prompt:

   ```
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

3. WebView2 runtime: already present on Windows 11.
4. `npm install` in this folder (the Tauri CLI).

`npx tauri info` reports what is missing.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Debug build, opens the window. The first build takes a few minutes. |
| `npm run build` | Release build plus the NSIS installer in `src-tauri/target/release/bundle/nsis/`. |
| `npm run build:exe` | Release executable only, in `src-tauri/target/release/`. |
| `cargo test` (in `src-tauri`) | Unit tests: navigation guard, deep-link routing, badge parsing, SSE parsing, agent config merge. |
| `node <scratch>/bridge-test.mjs <exe>` | Drives `--mcp` against a fake MCP server (auth, session, JSON, SSE, 202, 4xx). |
| `npm run icons` | Regenerates the icons from the brand SVG. |

## Releasing an update

Most changes need no desktop release: the window shows mepmail.dev, so a web
release reaches every installed app. Release the shell only when `src-tauri`
changes.

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json` (all three, same value).
2. Build with the updater key. The private key lives outside the repository,
   in `%USERPROFILE%\.tauri\mepmail-correio-updater.key` on Jean's PC (no
   password). Losing it means installed apps can never update again: keep a
   backup. `createUpdaterArtifacts` makes the build write `*.exe.sig` next to
   the installer.

   ```bash
   TAURI_SIGNING_PRIVATE_KEY="$USERPROFILE/.tauri/mepmail-correio-updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run build
   ```

3. Publish through a web release: copy the installer to
   `apps/web/public/desktop/correio/MepMail-Correio_<version>_x64-setup.exe`,
   remove the previous one, and rewrite `latest.json` there (version, notes,
   pub_date, `platforms.windows-x86_64.signature` = the `.sig` file content,
   `url` = the new installer). `route.test.ts` next to the download route
   checks the pair. Installed apps pick it up within 6 h, or at once from the
   tray.
4. Test locally first with a throwaway identifier, so nothing touches the
   installed app: build two versions with `--config` overriding
   `identifier`, `productName`, `version`, the deep-link scheme and
   `plugins.updater.endpoints` (`http://127.0.0.1:<port>/latest.json` plus
   `dangerousInsecureTransportProtocol: true`), install the older one, serve
   the newer one and click "Procurar atualizações".

The installer is not code-signed yet: SmartScreen shows "Windows protected
your PC" until it builds reputation (More info, Run anyway). A code-signing
certificate or the Microsoft Store removes that; both are a cost Jean decides.

## First-run checklist

- The window opens on the splash, then on the Correio sign-in or inbox.
- Sign in with email and password. Sign in with Google: WebView2 is a regular
  Edge engine, confirm Google does not refuse it.
- The session survives a restart (the WebView2 profile lives under
  `%LOCALAPPDATA%\dev.mepmail.correio`).
- A link inside an email opens the system browser. Buying a license sends
  Stripe Checkout to the browser as well.
- A second launch focuses the window. The tray click and menu work. The
  window comes back where it was.
- Started offline, the app shows the retry screen, and "Tentar de novo"
  works once the network is back.

## Web-side integration (a normal web release)

- CSP: add `ipc: http://ipc.localhost` to `connect-src` in
  `apps/web/next.config.ts`. Tauri's IPC from a remote page is a fetch to
  that origin; without it only the `__MEPMAIL_DESKTOP__` marker works.
- `apps/web/src/lib/desktop-bridge.ts`: when `window.__MEPMAIL_DESKTOP__`
  exists, set the native window title from the unread count and raise a
  notification for new unread mail. The capability grants the hosted origin
  `core:event:default`, `core:window:allow-set-title` and
  `notification:default`. The patch was handed to the apps/web owner on
  2026-10-09 (scratchpad `web-bridge/desktop-bridge.patch`).
- New-window requests (`target="_blank"`, `window.open`) reuse the main
  window only for mepmail.dev pages; a sign-in host, a blob or any other URL
  goes to the system browser or is refused.

### Follow-ups found in review (2026-10-09)

- The splash probe is a `no-cors` fetch, so a 5xx from mepmail.dev counts as
  "answers" and the user lands on the server's error page. Fix on the web
  side: a `GET /api/health` with `Access-Control-Allow-Origin: *`, then the
  probe uses `mode: "cors"` and `response.ok`.
- Stripe Checkout starts with `window.location.assign` in the web app; the
  shell cancels that navigation and opens the browser, but the page keeps its
  pending state. The desktop bridge should use `window.open` when
  `__MEPMAIL_DESKTOP__` exists and tell the user to finish in the browser.

## Roadmap

1. 0.1: this shell, the installer, the first-run checklist above.
2. 0.2, sign-in and agents:
   - Sign-in as an OAuth client of MepMail itself. The app opens the login in
     the system browser (Google and Turnstile work there), the browser returns
     the code through the `mepmail://` deep link, the refresh token lives in
     the Windows credential vault, and the app calls api.mepmail.dev with the
     JWT. The server side already exists: `oauthProvider` in
     `apps/web/src/server/auth.ts` (dynamic client registration, PKCE, consent
     page with team choice, one-hour JWT plus refresh). Open point: today's
     scopes cover the MCP only; a local UI needs Correio scopes.
   - "Agentes" screen: connect Claude Desktop, Claude Code, Codex and Cursor
     in one click by writing their MCP configuration (table below); Hermes
     and OpenClaw through their own CLI; the rest through a copyable snippet.
   - Local MCP bridge: the same executable started with `--mcp` speaks MCP
     over stdio and forwards to api.mepmail.dev with the credential from the
     vault (OAuth for the main MCP, the mailbox `mmb_` key for Correio). No
     Node, no mcp-remote, no key leaves the machine.
   - Owner approval as a native notification: the server already answers
     `awaiting_approval` for an agent without send permission; the app shows
     Approve / Refuse and an activity log per agent.
   - Web-side bridge (title badge, notifications), `mailto:` into the
     composer, the updater (signing key plus an endpoint on mepmail.dev), a
     code-signing certificate for SmartScreen (a cost, Jean decides), start
     with Windows, close-to-tray option.
3. 0.3: signed self-updates and the public download (done, see above).
4. 0.4: offline reading cache and the Correio UI extracted into a shared
   package loaded locally. The app stores reject plain web wrappers, so this
   is the step that unlocks Android and iOS builds from the same `src-tauri`.

## Agent targets for the "Agentes" screen (checked 2026-10-08)

| Agent | Where the MCP entry goes | How the app adds it |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` | Runs the command (already the snippet the dashboard shows). |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`, `mcpServers`, stdio only | Writes `command` = this executable with `--mcp`: the bridge replaces mcp-remote. |
| Codex CLI | `~/.codex/config.toml`, `[mcp_servers.<name>]` with `url` + `bearer_token_env_var`, or `codex mcp add <name> --url …`; OAuth via `codex mcp login` | Runs `codex mcp add`; for Correio sets the env var name, the key stays in the vault/env. |
| Cursor | `~/.cursor/mcp.json`, `mcpServers` with `url` or `command` | Writes the entry. |
| Hermes Agent | `~/.hermes/config.yaml`, `mcp_servers:` map; remote = `url` + `headers.Authorization`, stdio = `command`/`args`; `/reload-mcp` or restart | Writes the YAML entry (per profile under `~/.hermes/profiles/<name>/config.yaml` when profiles are in use). |
| OpenClaw | Settings > MCP in its Control UI, or `openclaw mcp add <name> --url … --transport streamable-http` (stdio: `--command … --arg …`); config key `mcp.servers`; the file location differs between versions | Runs `openclaw mcp add`, never edits the file by hand. |

## Decisions

- Tauri over Electron: an installer of a few megabytes instead of a hundred,
  less memory, and one shell for desktop and mobile. The cost is the MSVC
  toolchain on the build machine.
- Hosted UI instead of a bundled copy for 0.1: no second copy of the Correio
  UI to keep in sync, parity with every web release. Offline arrives with the
  local bundle in 0.3.
- Correio is the app; Send is a secondary section (Jean, 2026-10-08). The
  dashboard stays reachable in the same window, but the app is an email
  client first, not the website in a window.
- The agents hub is the app's differentiator, not an extra: one-click
  connection, the local bridge and native approvals are what a browser tab
  cannot offer.
- Experience bar (Jean, 2026-10-09): Spark by Readdle, or better. Smart and
  priority inbox, snooze, send later, reminders, pin and done flow, a
  gatekeeper for new senders, templates, keyboard-first, native
  notifications. Most of it lives in the web Correio UI that desktop and
  mobile share; the shell owns the native layer (notifications, tray,
  shortcuts, offline).
