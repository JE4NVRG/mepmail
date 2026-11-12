export interface OnboardingRegion {
  code: string;
  production: boolean;
  sendingHealthy?: boolean;
}
/** New identities only. An explicit selection (or existing domain region) is never rewritten. */
export function recommendedDomainRegion(
  regions: readonly OnboardingRegion[],
  selected = "",
): string {
  if (selected) return selected;
  return (
    (
      regions.find((r) => r.sendingHealthy === true && r.production) ??
      regions.find((r) => r.production) ??
      regions[0]
    )?.code ?? ""
  );
}
