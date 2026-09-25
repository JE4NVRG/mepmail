/**
 * Where the dashboard sends people for documentation. The docs are not published
 * as a site yet, so these point at the source in the public repository, which
 * GitHub renders as the same pages.
 */
export const DOCS_URL = "https://github.com/JE4NVRG/millionsend/blob/main/apps/docs/content/docs";
export const MCP_DOCS_URL = `${DOCS_URL}/mcp.mdx`;
export const MIGRATE_DOCS_URL = `${DOCS_URL}/migrate-from-resend.mdx`;
/** The relay has no page of its own; it is a section of the self-hosting page. */
export const SMTP_DOCS_URL = `${DOCS_URL}/self-hosting.mdx#smtp-relay`;
export const OPEN_TRACKING_DOCS_URL = `${DOCS_URL}/concepts/domains.mdx#open-rate-accuracy`;
export const CONTENT_MONITORING_DOCS_URL = `${DOCS_URL}/self-hosting.mdx#content-monitoring-optional`;
/** Product updates land as commits; a self-hosted instance only links here. */
export const UPDATES_URL = "https://github.com/JE4NVRG/millionsend/commits/main";
