/**
 * "Testar conexão" on the agents page: the dashboard dials the public Correio
 * MCP endpoint with the key the person just created, exactly as their MCP
 * client will, and lists what the key reaches. The URL is the server's own
 * (never one the browser names) and the key is used for this one call only:
 * it is not stored, logged or echoed back.
 */

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 10_000;
export const CORREIO_AGENT_KEY = /^mm[bt]_[A-Za-z0-9_.-]{20,200}$/;

export interface CorreioConnectionMailbox {
  address: string;
  scopes: string[];
  available: boolean;
}
export type CorreioConnectionResult =
  | { ok: true; mailboxes: CorreioConnectionMailbox[]; latencyMs: number }
  | { ok: false; reason: "rejected" | "unreachable" | "unexpected"; status?: number };

type Fetch = typeof fetch;

/** The JSON-RPC message answering `id`, from a JSON body or a text/event-stream one. */
async function rpcMessage(res: Response, id: number): Promise<Record<string, unknown> | null> {
  const body = await res.text();
  const candidates = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [body];
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as Record<string, unknown>;
      if (message && message.id === id) return message;
    } catch {
      // Not this line; keep looking.
    }
  }
  return null;
}

function mailboxesFrom(result: unknown): CorreioConnectionMailbox[] | null {
  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  const text = content?.find((part) => part.type === "text")?.text;
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const payload = (data as { untrusted_data?: unknown }).untrusted_data ?? data;
  const boxes = (payload as { mailboxes?: unknown } | null)?.mailboxes;
  if (!Array.isArray(boxes)) return null;
  return boxes
    .filter(
      (box): box is { address: string; scopes?: unknown; available?: unknown } =>
        typeof (box as { address?: unknown })?.address === "string",
    )
    .map((box) => ({
      address: box.address,
      scopes: Array.isArray(box.scopes)
        ? box.scopes.filter((scope): scope is string => typeof scope === "string")
        : [],
      available: box.available === true,
    }));
}

export async function testCorreioConnection(
  url: string,
  token: string,
  deps: { fetch?: Fetch; now?: () => number } = {},
): Promise<CorreioConnectionResult> {
  if (!CORREIO_AGENT_KEY.test(token)) return { ok: false, reason: "rejected" };
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const started = now();
  let session: string | null = null;
  const post = async (body: Record<string, unknown>) =>
    doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    const init = await post({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mepmail-dashboard-connection-test", version: "1" },
      },
    });
    if (init.status === 401 || init.status === 403)
      return { ok: false, reason: "rejected", status: init.status };
    if (!init.ok) return { ok: false, reason: "unexpected", status: init.status };
    session = init.headers.get("mcp-session-id");
    if (!(await rpcMessage(init, 1))?.result) return { ok: false, reason: "unexpected" };
    const call = await post({
      id: 2,
      method: "tools/call",
      params: { name: "mailbox_list_accounts", arguments: {} },
    });
    if (call.status === 401 || call.status === 403)
      return { ok: false, reason: "rejected", status: call.status };
    if (!call.ok) return { ok: false, reason: "unexpected", status: call.status };
    const message = await rpcMessage(call, 2);
    const result = message?.result as { isError?: boolean } | undefined;
    if (!result) return { ok: false, reason: "unexpected" };
    // The agent API refused the key (revoked, expired or not this team's).
    if (result.isError) return { ok: false, reason: "rejected" };
    const mailboxes = mailboxesFrom(result);
    if (!mailboxes) return { ok: false, reason: "unexpected" };
    return { ok: true, mailboxes, latencyMs: Math.max(0, Math.round(now() - started)) };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
