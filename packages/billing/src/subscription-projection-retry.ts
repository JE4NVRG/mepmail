/** A stale local projection is never authority to apply a provider snapshot. */
export class SubscriptionProjectionChangedError extends Error {
  override readonly name = "SubscriptionProjectionChangedError";
}

/** Retry once only after the failed transaction has rolled back. A new attempt
 * must re-read both local authority and the provider outside transaction locks.
 * Unknown/transport/identity failures and persistent contention still fail closed.
 */
export async function withSubscriptionProjectionRetry<Prepared, Result>(
  prepare: () => Promise<Prepared>,
  apply: (prepared: Prepared) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    const prepared = await prepare();
    try {
      return await apply(prepared);
    } catch (error) {
      if (!(error instanceof SubscriptionProjectionChangedError) || attempt >= 1) throw error;
    }
  }
}
