import { getDb } from "@millionsend/db";
import { azureEmailEventStore } from "@/server/azure-email-event-store";
import { handleAzureEmailEvents } from "@/server/azure-email-events";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAzureEmailEvents(request, {
    env: process.env,
    // No DB acquisition for handshake or rejected auth/schema/scope checks.
    store: () => azureEmailEventStore(getDb()),
  });
}
