import type { HighlightLanguage } from "@/components/code-highlight";

/* Pinned: `npx -y mcp-remote` would run whatever version npm serves next. */
const MCP_REMOTE = "mcp-remote@0.8.2";

/* Client names are product names, not translatable copy. */
export const MCP_CLIENTS = ["claudeCode", "claudeDesktop", "cursor", "vscode"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  claudeCode: "Claude Code",
  claudeDesktop: "Claude Desktop",
  cursor: "Cursor",
  vscode: "VS Code",
};

/**
 * Ready-to-paste client snippet connecting to the hosted MepMail MCP server.
 */
export function mcpClientSnippet(
  client: McpClient,
  url: string,
): { code: string; language: HighlightLanguage } {
  switch (client) {
    case "claudeCode":
      return { code: `claude mcp add --transport http mepmail ${url}`, language: "bash" };
    // Claude Desktop's config file only launches stdio servers; mcp-remote
    // bridges it to the Streamable HTTP endpoint.
    case "claudeDesktop":
      return {
        code: `{
  "mcpServers": {
    "mepmail": {
      "command": "npx",
      "args": ["-y", "${MCP_REMOTE}", "${url}"]
    }
  }
}`,
        language: "json",
      };
    case "cursor":
      return {
        code: `{
  "mcpServers": {
    "mepmail": {
      "url": "${url}"
    }
  }
}`,
        language: "json",
      };
    case "vscode":
      return {
        code: `{
  "servers": {
    "mepmail": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
        language: "json",
      };
  }
}

/** Analytics event key differentiating CLI install vs JSON config copy. */
export function mcpCopyEvent(code: string): string {
  return code.startsWith("claude mcp add") ? "mcp_add_click" : "mcp_copy";
}
