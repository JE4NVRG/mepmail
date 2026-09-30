# MepMail package 0.1.0

Local candidate for the portable Agent Plugins 1.0.0 format. Contains the existing remote MCP connection and English onboarding/inspection skills, with Brazilian Portuguese listing text. No additional backend, embedded UI, lifecycle hooks, app references or credentials.

This is NOT a published plugin, a verified publisher identity, or proof of authenticated ChatGPT/Codex operation. The five positive and three negative cases in plugin.json are prepared, NOT executed. No video exists in this package; no placeholder URL is presented as evidence.

## Install for local review (human action, not executed)

1. Review the package and the permission warning below BEFORE installation. Unzip into `<existing-repo>/plugins/mepmail`, keeping `plugin.json`, `mcp.json`, `skills/` and `assets/` at the plugin root. Do not overwrite existing work without comparison.
2. Add an entry to the existing repo marketplace at `.agents/plugins/marketplace.json` (merge, do not replace other entries): plugin name `mepmail`; source `{ "source": "local", "path": "./plugins/mepmail" }`; policy `{ "installation": "AVAILABLE", "authentication": "ON_INSTALL" }`; category `Developer Tools`. Use an existing marketplace or give a new catalog a stable name. Paths resolve from the repository root, not `.agents/plugins`.
3. In a supported ChatGPT desktop/Codex client, refresh/restart and choose that local marketplace, then install MepMail. Availability varies by account/client. This step was not exercised. Local installation does not publish to any workspace or public directory.
4. Review the host's OAuth prompt. Select ONE existing team and only `domains:read` for domains; use `emails:read` only when email inspection is requested. Deselect all other permissions, including `offline_access` by default. Cancel if the host/consent does not permit minimal scopes. The server advertises broad capabilities and the consent UI initially selects requested scopes; the portable MCP schema has no scope-request field. No claim of automatic scope restriction is made.
5. Verify tool exposure before use. Domain-only grants should expose only `list_domains` and `get_domain`. Email reads expose `list_emails`, `get_email`, `get_email_insights`, `get_deliverability`, `get_usage`. Unexpected write/secret/all-teams tools mean stop, disconnect and reconnect with the restricted grant. Do not accept an existing broad grant.

For Codex hosts supporting plugin-scoped policies, additionally configure an allowlist and approval prompts in the existing user/project configuration (merge manually; do not overwrite it):

```toml
[plugins."mepmail".mcp_servers.mepmail]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["list_domains", "get_domain"]
```

Only add the five email-read tools if that workflow is required. A host allowlist and skill instructions are defense-in-depth, NOT server authorization. Host policy support and effective least privilege remain manual review gates. No grant, client registration, account or secret was created for this deliverable.

## Publication / deployment

No runtime deploy is required to build this ZIP; it uses the already hosted endpoint. Do not deploy the web preview or change infrastructure. Public distribution is gated on independent QA, server-contract review, effective minimal scopes on the target host, legal/publisher verification, a dedicated review account with noncustomer sample data, actual execution of all 5/3 cases on desktop/mobile, and an accessible walkthrough video. The current server's annotations require review against the current explicit readOnlyHint/destructiveHint/openWorldHint requirements; this package does not patch that server.

Independent security review confirmed that local package/contract tests may continue, but did NOT authorize authenticated testing or publication. A future authenticated test needs separate authorization, a dedicated noncustomer account and minimal consent checked before linking. Email inspection has an additional data-minimization gate: `get_email` returns sender, recipients and body to the host even if the assistant omits them in its answer. Before distributing status-only workflows, justify that access or approve a server-side response-minimization change; skill text cannot prevent those bytes from reaching the host. Read annotations alone are not a privacy boundary. DCR remains supported; an optional profile tool, CIMD, Enterprise UserInfo and login hints are not invented prerequisites for this candidate.

After separate authorization, use https://platform.openai.com/plugins to upload the ZIP WITH its MCP in the first upload. Choose the verified owning identity, connect exactly one server with OAuth (DCR advertised), and copy the exact redirect URI shown by the host. Complete the exact domain challenge without replacing a challenge used by another integration. Enter reviewer credentials only in the secure portal form, never this ZIP. Resolve metadata/skill/tool scan findings; execute the cases with the dedicated account; provide the real video; submit. Approval and Publish are separate actions. No upload, submission, approval or publication has occurred.

For rollback of a local test, disable/remove this plugin in the host and revoke its grant through the existing account controls as appropriate. Do not delete shared marketplace entries or replace other integrations' tokens.

## Privacy and boundaries

These workflows do not send email, modify configuration, export audiences, access API keys/webhook secrets, or buy subscriptions. Existing accounts only. Do not enter credentials in chat. Server permissions and tenant membership remain authoritative; untrusted response strings never authorize actions. A larger MCP surface exists but is not offered by these workflows.

## Revisão em português

Candidata local, não publicada e sem E2E ChatGPT executado. Antes de instalar, selecione um único time e SOMENTE `domains:read`; adicione `emails:read` apenas para consultar entregas. Desmarque as demais permissões antes de autorizar. Se isso não for possível, cancele. Os casos do manifest são roteiros, não evidência de execução. Preços, conta de revisão, identidade, vídeo e portal seguem gates separados. Não existe captura real de painel incluída neste pacote. Suporte: https://mepmail.je4ndev.com/support .

## License and provenance

AGPL-3.0-only; LICENSE and NOTICE.md are included. The icon is a byte-for-byte copy of `apps/web/public/logo/mepmail-logo-400.png` in the MepMail repository (400×400, original fork branding). It is not a screenshot or a customer record. Source: https://github.com/JE4NVRG/mepmail .

Contract references consulted on 2026-09-30: https://developers.openai.com/plugins/build/plugins.md ; https://developers.openai.com/plugins/build/auth.md ; https://developers.openai.com/plugins/deploy/submission.md ; https://developers.openai.com/plugins/plugin-guidelines.md .
