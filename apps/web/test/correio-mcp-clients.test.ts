import { describe, expect, it } from "vitest";
import {
  CORREIO_MCP_CLIENTS,
  CORREIO_MCP_SERVER_NAME,
  correioClientSnippet,
} from "@/lib/correio-mcp-clients";

const URL_ = "https://api.mepmail.dev/mcp/correio";
const TOKEN = `mmb_${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}.${"b".repeat(43)}`;

describe("correioClientSnippet", () => {
  it("gives Claude Code one command with the bearer header", () => {
    expect(correioClientSnippet("claude-code", URL_, TOKEN)).toEqual({
      kind: "command",
      text: `claude mcp add --transport http mepmail-correio ${URL_} --header "Authorization: Bearer ${TOKEN}"`,
    });
  });

  it("writes valid JSON for the JSON-configured clients, each in its own shape", () => {
    const desktop = JSON.parse(correioClientSnippet("claude-desktop", URL_, TOKEN).text);
    expect(desktop.mcpServers[CORREIO_MCP_SERVER_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@mepmail/mcp"],
      env: { MEPMAIL_MAIL_TOKEN: TOKEN },
    });
    const cursor = JSON.parse(correioClientSnippet("cursor", URL_, TOKEN).text);
    expect(cursor.mcpServers[CORREIO_MCP_SERVER_NAME]).toEqual({
      url: URL_,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const vscode = JSON.parse(correioClientSnippet("vscode", URL_, TOKEN).text);
    expect(vscode.servers[CORREIO_MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: URL_,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("names the file to edit for every config snippet and carries the key in each", () => {
    for (const client of CORREIO_MCP_CLIENTS) {
      const snippet = correioClientSnippet(client, URL_, TOKEN);
      expect(snippet.text, client).toContain(TOKEN);
      if (snippet.kind === "config" && client !== "other")
        expect(snippet.file, client).toBeTruthy();
    }
    expect(correioClientSnippet("codex", URL_, TOKEN).text).toBe(
      [
        "[mcp_servers.mepmail-correio]",
        'command = "npx"',
        'args = ["-y", "@mepmail/mcp"]',
        `env = { MEPMAIL_MAIL_TOKEN = "${TOKEN}" }`,
      ].join("\n"),
    );
  });
});
