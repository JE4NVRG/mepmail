/* The registry moved to @millionsend/core/mcp-tools so the API can serve the
   static MCP server card from its own origin (the origin a directory's
   scanner reads) without a second copy. Kept as a re-export: the settings page
   and the sync test import this path. */
export { MCP_TOOLS } from "@millionsend/core/mcp-tools";
