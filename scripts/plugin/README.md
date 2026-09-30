# Plugin package verification

Run on the existing Windows development export F:\MepMail, with Python 3.13 and jsonschema 4.26.0. No web/backend build or service start is needed for a package-only change.

```powershell
Set-Location F:\MepMail
python -m pip install --user jsonschema==4.26.0
python -B -m unittest discover -s scripts/plugin -p test_package.py -v
python -B scripts/plugin/package.py --output F:/MepMail-artifacts/plugin/mepmail-0.1.0.zip
```

The packager accepts only the explicit public file allowlist, compares icon/LICENSE/NOTICE bytes with the repository, validates the two official schemas plus supported OpenAI listing/path/review fields, checks credential-like patterns, creates a deterministic ZIP and validates its exact content again. A different existing ZIP is never overwritten. Temporary test archives are in memory; no clone, environment or stack is created. The secret-pattern check is a guardrail, not an exhaustive secret scanner; the allowlist and human review remain necessary.

The official schemas in `schemas/` were downloaded verbatim from https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and https://agent-plugins.org/schemas/1.0.0/mcp.schema.json on 2026-09-30. They define portable syntax; OpenAI extension semantics are checked separately against https://developers.openai.com/plugins/deploy/submission.md . These are local checks, not the portal's proprietary validator or proof of accepted upload.

For the existing scope/tenant enforcement, run the focused API MCP suite with the repo's test environment and dummy PGlite database (`pnpm --filter @millionsend/api exec vitest run test/mcp.test.ts`). It does not prove production OAuth or ChatGPT E2E. No account, grant, production database or real email may be used in these local gates.

Installation and publication gates: `plugins/mepmail/README.md`. Keep artifacts outside the source package, preserve the active candidate until QA finishes, and remove only disposable files created by this packaging run. A runtime release is not part of packaging.
