import { startMailboxExternalOAuth } from "@/server/mailbox-external-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Entrar com a Microsoft/o Google" for a conta externa (server/mailbox-external-oauth.ts). */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  return startMailboxExternalOAuth(request, provider);
}
