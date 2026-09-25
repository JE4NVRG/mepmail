const BODY = `# MepMail

> This host is the MepMail dashboard (sign-in required). Documentation lives on the docs site below.

- Documentation: https://docs-mepmail.agenciamep.com
- Full documentation in one file: https://docs-mepmail.agenciamep.com/llms-full.txt
- OpenAPI 3.1 spec: https://api-mepmail.agenciamep.com/openapi.json
`;

export function GET(): Response {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
