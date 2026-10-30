export interface AzureApiOptoutBody {
  from: string;
  html: string | null | undefined;
  text: string | null | undefined;
  url: string;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);

/** Provider-required identity and recipient-scoped opt-out, not marketing consent.
 * Called before MIME construction/tracking, never after an immutable send claim.
 * The URL must come from the canonical signed recipient opt-out builder.
 */
export function appendAzureApiOptoutBody(input: AzureApiOptoutBody): {
  html: string | null;
  text: string;
} {
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/unsubscribe\/recipient\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error("azure_recipient_optout_url_invalid");
  }
  if (!input.from || /[\r\n]/.test(input.from)) throw new Error("azure_sender_identity_invalid");
  const label =
    "Parar de receber todas as mensagens desta equipe / Stop all messages from this team";
  const identity = `Enviado por / Sent by: ${input.from}`;
  const footerText = `${identity}\n${label}: ${url.toString()}`;
  // Always label the control explicitly, even if the original body mentioned the URL.
  const text = [input.text, footerText].filter(Boolean).join("\n\n");
  let html = input.html ?? null;
  if (html) {
    const footer = `<div style="display:block!important;margin-top:24px!important;font:12px sans-serif!important;color:#555!important"><p>${escapeHtml(identity)}</p><p><a href="${escapeHtml(url.toString())}" style="display:inline!important;color:#555!important;text-decoration:underline!important">${escapeHtml(label)}</a></p></div>`;
    // An untrusted sender's existing link is not proof that it is visible or canonical.
    // This generated footer is deterministic and independent of user-supplied headers.
    html = /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${footer}</body>`)
      : html + footer;
  }
  return { html, text };
}
