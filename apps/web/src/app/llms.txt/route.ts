const BODY = `# MepMail

> This host is the MepMail dashboard (sign-in required). The documentation source is public in the repository below.

- Documentation source: https://github.com/JE4NVRG/millionsend/tree/main/apps/docs/content
- OpenAPI 3.1 spec: https://api-mepmail.agenciamep.com/openapi.json
- Repository: https://github.com/JE4NVRG/millionsend
`;

export function GET(): Response {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
