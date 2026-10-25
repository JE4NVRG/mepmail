# Verification sources

- Plugin and marketplace schemas: https://github.com/cursor/plugins/tree/190d28736eff128ec94f502a22c7fe0c4b56cd37/schemas
- Packaging and discovery: https://cursor.com/docs/plugins/building
- Submission destinations and publisher terms: https://x.ai/bot/marketplace/submit-a-plugin
- Hosted endpoint and current tool behavior: https://docs.mepmail.dev/mcp
- OAuth scopes and mailbox gates: https://github.com/JE4NVRG/mepmail/blob/5f473bf3432eb054659c57ba5d2601c6823448f3/packages/core/src/oauth-scopes.ts
- Hosted tool registration: https://github.com/JE4NVRG/mepmail/blob/5f473bf3432eb054659c57ba5d2601c6823448f3/apps/api/src/mcp.ts
- Server license, not the plugin license: https://github.com/JE4NVRG/mepmail/blob/5f473bf3432eb054659c57ba5d2601c6823448f3/LICENSE
- Separately published MCP client license: https://github.com/JE4NVRG/mepmail/blob/5f473bf3432eb054659c57ba5d2601c6823448f3/packages/mcp/LICENSE
- Logos match the canonical PNG and SVG under apps/web/public/logo at that same source revision.

The packaged manifest and repository-root marketplace index were validated against the pinned schemas. Version 0.1.0 is the integration's initial release, not the server/package version. The live hosted endpoint was tested with an isolated tenant and OAuth/PKCE: scoped tools, verified domain, one controlled send, delivery status and exact inbox-body readback. This does not assert installation or testing inside Grok Bot or Cursor, or marketplace acceptance.
