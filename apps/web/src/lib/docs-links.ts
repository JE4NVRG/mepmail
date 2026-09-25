/**
 * Where the dashboard sends people for documentation: the public docs site,
 * generated from `apps/docs/content`. Every path here was checked against the
 * deployed site.
 */
export const DOCS_URL = "https://docs-mepmail.agenciamep.com";
export const MCP_DOCS_URL = `${DOCS_URL}/mcp`;
export const MIGRATE_DOCS_URL = `${DOCS_URL}/migrate-from-resend`;
/** The relay has no page of its own; it is a section of the self-hosting page. */
export const SMTP_DOCS_URL = `${DOCS_URL}/self-hosting#smtp-relay`;
export const OPEN_TRACKING_DOCS_URL = `${DOCS_URL}/concepts/domains#open-rate-accuracy`;
export const CONTENT_MONITORING_DOCS_URL = `${DOCS_URL}/self-hosting#content-monitoring-optional`;
/** Product updates land as commits; a self-hosted instance only links here. */
export const UPDATES_URL = "https://github.com/JE4NVRG/mepmail/commits/main";
