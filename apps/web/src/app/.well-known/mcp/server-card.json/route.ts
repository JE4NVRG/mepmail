import { MCP_SERVER_CARD_CONTENT_TYPE, mcpServerCardBody } from "@millionsend/core/mcp-server-card";

/**
 * MCP server card for the hosted MepMail MCP server, on the dashboard origin:
 * advertised by /.well-known/ai-catalog.json and linked from auth.md.
 *
 * The document itself lives in @millionsend/core/mcp-server-card, because the
 * API serves the very same bytes on the MCP endpoint's origin — the origin a
 * directory's scanner actually reads when OAuth blocks its scan. See that
 * module for the reasoning.
 */

export function GET(): Response {
  return new Response(mcpServerCardBody(), {
    headers: { "Content-Type": MCP_SERVER_CARD_CONTENT_TYPE },
  });
}
