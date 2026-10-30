import { env } from "@millionsend/config";
import { deriveUnsubscribeKey } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import {
  recordAzureRecipientOptout,
  verifyAzureRecipientOptoutToken,
} from "../../../../../../../packages/core/src/azure-recipient-optout.js";

function target(token: string) {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  return verifyAzureRecipientOptoutToken(
    token,
    deriveUnsubscribeKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64")),
  );
}
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
};
/** Scanner-safe: GET never writes. No session/login/recipient disclosure required. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const parsed = target((await ctx.params).token);
  if (!parsed) return new Response("Invalid opt-out link", { status: 404, headers });
  return new Response(
    `<!doctype html><html lang="en"><title>Stop emails</title><h1>Stop emails from this team</h1><p>Isso interrompe mensagens deste canal de e-mail, incluindo avisos de serviço e mensagens transacionais. Outras equipes não são afetadas. / This stops emails from this sending team, including service and transactional messages. Other teams are unaffected.</p><form method="post"><button type="submit">Stop emails from this team</button></form></html>`,
    { headers },
  );
}
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const parsed = target((await ctx.params).token);
  if (!parsed) return new Response("Invalid opt-out link", { status: 404, headers });
  await recordAzureRecipientOptout(getDb(), parsed);
  return new Response(
    '<!doctype html><html lang="en"><title>Emails stopped</title><h1>Emails stopped from this team</h1><p>Your opt-out is saved. It includes Azure-delivered service and transactional emails.</p></html>',
    { headers },
  );
}
