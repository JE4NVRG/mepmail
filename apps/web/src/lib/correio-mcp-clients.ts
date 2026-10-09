/**
 * Ready-to-paste setup for the Correio MCP, per client. Remote-capable clients
 * dial the hosted endpoint with the key as a bearer header; Claude Desktop and
 * Codex run the @mepmail/mcp package locally, which reads the key from its env.
 * Every snippet carries the secret, so each is shown only beside a new key.
 */
export const CORREIO_MCP_CLIENTS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "codex",
  "other",
] as const;
export type CorreioMcpClient = (typeof CORREIO_MCP_CLIENTS)[number];

/** The server name every snippet registers, so tools show up as mepmail-correio. */
export const CORREIO_MCP_SERVER_NAME = "mepmail-correio";

export interface CorreioClientSnippet {
  /** What the person pastes: a terminal command or a config file fragment. */
  text: string;
  /** "command" goes in a terminal; "config" into the file named by `file`. */
  kind: "command" | "config";
  file?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function correioClientSnippet(
  client: CorreioMcpClient,
  url: string,
  token: string,
): CorreioClientSnippet {
  const name = CORREIO_MCP_SERVER_NAME;
  const authorization = `Bearer ${token}`;
  switch (client) {
    case "claude-code":
      return {
        kind: "command",
        text: `claude mcp add --transport http ${name} ${url} --header "Authorization: ${authorization}"`,
      };
    case "claude-desktop":
      return {
        kind: "config",
        file: "claude_desktop_config.json",
        text: json({
          mcpServers: {
            [name]: {
              command: "npx",
              args: ["-y", "@mepmail/mcp"],
              env: { MEPMAIL_MAIL_TOKEN: token },
            },
          },
        }),
      };
    case "cursor":
      return {
        kind: "config",
        file: "~/.cursor/mcp.json",
        text: json({ mcpServers: { [name]: { url, headers: { Authorization: authorization } } } }),
      };
    case "vscode":
      return {
        kind: "config",
        file: ".vscode/mcp.json",
        text: json({
          servers: { [name]: { type: "http", url, headers: { Authorization: authorization } } },
        }),
      };
    case "codex":
      return {
        kind: "config",
        file: "~/.codex/config.toml",
        text: [
          `[mcp_servers.${name}]`,
          `command = "npx"`,
          `args = ["-y", "@mepmail/mcp"]`,
          `env = { MEPMAIL_MAIL_TOKEN = "${token}" }`,
        ].join("\n"),
      };
    case "other":
      return { kind: "config", text: `URL: ${url}\nAuthorization: ${authorization}` };
  }
}
