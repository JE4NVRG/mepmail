// Pure constants shared by the "Configurar na Cloudflare" card and the server.

/** Cloudflare API tokens: 40 URL-safe characters today; leave room for new formats. */
export const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{30,200}$/;

/**
 * Cloudflare's documented token-template link: opens "Create token" with the
 * two permissions we need pre-filled (Zone: Read, DNS: Edit). The person
 * narrows "Zone resources" to their domain before creating it.
 */
export const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
  ]),
)}&accountId=*&zoneId=all&name=${encodeURIComponent("MepMail DNS")}`;
