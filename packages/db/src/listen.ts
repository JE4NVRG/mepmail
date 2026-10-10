import postgres from "postgres";

/**
 * A dedicated connection that LISTENs on one channel and hands each payload
 * to `onPayload` (postgres-js reconnects and re-listens by itself). LISTEN
 * needs a session, so `url` must reach Postgres directly, not through a
 * transaction-mode pooler. Resolves once listening; `stop` ends it.
 */
export async function listenToChannel(
  url: string,
  channel: string,
  onPayload: (payload: string) => void,
): Promise<{ stop: () => Promise<void> }> {
  const client = postgres(url, { prepare: false, max: 1 });
  try {
    await client.listen(channel, (payload: string) => onPayload(payload));
  } catch (error) {
    await client.end({ timeout: 1 });
    throw error;
  }
  return { stop: () => client.end({ timeout: 1 }) };
}
