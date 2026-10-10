/**
 * A stripe-node HttpClient that sends every request through the paired Stripe
 * CLI (`stripe login`), so the test-mode end to end runs without copying any
 * key into the environment. The CLI never gets --live: it answers from the
 * sandbox only, and a live-mode object in a response fails the request.
 */
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import Stripe from "stripe";

type Headers = Record<string, string>;

class CliResponse extends Stripe.HttpClientResponse {
  constructor(
    status: number,
    headers: Headers,
    private readonly body: string,
  ) {
    super(status, headers);
  }
  // The SDK copies the headers onto this object as `lastResponse`.
  override getRawResponse() {
    return { statusCode: this.getStatusCode(), body: this.body };
  }
  override toStream(done: () => void) {
    done();
    return Readable.from([this.body]);
  }
  override toJSON() {
    return Promise.resolve(this._parseResponseBody(this.body));
  }
}

function header(headers: Record<string, unknown>, name: string) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

export function cliArgs(
  method: string,
  path: string,
  headers: Record<string, unknown>,
  requestData: string,
) {
  const [pathname = "", query = ""] = path.split("?");
  const args = [method.toLowerCase(), pathname, "--show-headers", "--confirm", "--color", "off"];
  for (const source of [query, requestData])
    for (const [key, value] of new URLSearchParams(source)) args.push("-d", `${key}=${value}`);
  const idempotency = header(headers, "Idempotency-Key");
  if (idempotency) args.push("-i", idempotency);
  const version = header(headers, "Stripe-Version");
  if (version) args.push("-v", version);
  return args;
}

export function parseCliOutput(stdout: string, stderr: string) {
  const status = /^< HTTP (\d{3})\b/m.exec(stderr);
  if (!status) throw new Error(`Stripe CLI gave no HTTP status: ${stderr.trim().slice(0, 300)}`);
  const headers: Headers = {};
  for (const [, name, value] of stderr.matchAll(/^< ([A-Za-z0-9-]+): (.*)$/gm))
    if (name && value !== undefined) headers[name.toLowerCase()] = value.trim();
  const body = stdout.trim() || "{}";
  if ((JSON.parse(body) as { livemode?: unknown }).livemode === true)
    throw new Error("Stripe CLI answered with a live-mode object; the e2e runs in test mode only");
  return { status: Number(status[1]), headers, body };
}

export function stripeCliHttpClient(binary = "stripe") {
  class CliHttpClient extends Stripe.HttpClient {
    override getClientName() {
      return "stripe-cli";
    }
    override makeRequest(
      _host: string,
      _port: string,
      path: string,
      method: string,
      headers: Record<string, unknown>,
      requestData: string,
      _protocol: string,
      timeout: number,
    ) {
      const args = cliArgs(method, path, headers, requestData);
      return new Promise<CliResponse>((resolve, reject) => {
        execFile(
          binary,
          args,
          { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (error && !/^< HTTP \d{3}/m.test(stderr)) return reject(error);
            try {
              const { status, headers: responseHeaders, body } = parseCliOutput(stdout, stderr);
              resolve(new CliResponse(status, responseHeaders, body));
            } catch (failure) {
              reject(failure);
            }
          },
        );
      });
    }
  }
  return new CliHttpClient();
}
