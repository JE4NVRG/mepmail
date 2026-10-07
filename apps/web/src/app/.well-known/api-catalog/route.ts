/**
 * RFC 9727 API catalog (linkset+json): points machines at the MepMail API,
 * its OpenAPI 3.1 definition and its documentation. Advertised by
 * /.well-known/ai-catalog.json; shape modelled on Postmark's api-catalog.
 */
const BODY = JSON.stringify(
  {
    linkset: [
      {
        anchor: "https://api.mepmail.dev/",
        "service-desc": [
          {
            href: "https://api.mepmail.dev/openapi.json",
            type: "application/json",
            title: "MepMail API (OpenAPI 3.1)",
          },
        ],
        "service-doc": [
          {
            href: "https://docs.mepmail.dev",
            type: "text/html",
            title: "MepMail documentation",
          },
          {
            href: "https://docs.mepmail.dev/llms-full.txt",
            type: "text/plain",
            title: "MepMail documentation in one file",
          },
          {
            href: "https://mepmail.dev/auth.md",
            type: "text/markdown",
            title: "Authentication for agents",
          },
        ],
      },
    ],
  },
  null,
  2,
);

export function GET(): Response {
  return new Response(BODY, {
    headers: { "Content-Type": "application/linkset+json; charset=utf-8" },
  });
}
