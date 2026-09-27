/**
 * Minimal HTTP client for one MepMail instance. The local MCP server speaks the
 * public REST API over HTTPS exactly like any other integration — it holds an
 * API key (`ms_...`) and nothing else. Env conventions match `@millionsend/cli`.
 */
export interface MepMailClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

/** A non-2xx API reply, carrying the parsed error body (`statusCode`/`name`/`message`). */
export class MepMailApiError extends Error {
  readonly status: number;
  readonly apiName: string;
  readonly payload: unknown;
  constructor(status: number, apiName: string, payload: unknown) {
    super(`MepMail API error ${status} (${apiName})`);
    this.name = "MepMailApiError";
    this.status = status;
    this.apiName = apiName;
    this.payload = payload;
  }
}

export interface ClientOptions {
  /** The team API key: `ms_...`. Never logged, never sent anywhere else. */
  apiKey: string;
  /** Instance base URL, e.g. `https://api-mepmail.je4ndev.com` (a trailing slash is fine). */
  baseUrl: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function apiErrorName(data: unknown, status: number): string {
  if (data && typeof data === "object" && "name" in data) {
    const name = (data as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return `http_${status}`;
}

export function createClient(options: ClientOptions): MepMailClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        throw new MepMailApiError(res.status, apiErrorName(data, res.status), data);
      }
      return data;
    },
  };
}
