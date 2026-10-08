/**
 * NEW_SUBSCRIPTIONS_PAUSED=true stops new purchases (a Send plan for a team
 * without one, a new Correio license) while the platform cannot deliver what
 * it would sell. Existing subscriptions keep every action: plan changes, the
 * portal, cancellation. Read per call, so flipping the variable needs only a
 * restart, never a rebuild.
 */
export function newSubscriptionsPaused(): boolean {
  const value = process.env.NEW_SUBSCRIPTIONS_PAUSED;
  return value === "true" || value === "1";
}
