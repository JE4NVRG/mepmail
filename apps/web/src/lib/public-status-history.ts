export interface PublishedIncident {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  summary: { en: string; "pt-BR": string };
}

/** Add only incidents approved for public disclosure; never infer an uptime history. */
export const PUBLISHED_INCIDENTS: readonly PublishedIncident[] = [];
