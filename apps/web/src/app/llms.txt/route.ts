const BODY = `# MepMail

> This host is the MepMail dashboard (sign-in required). Documentation and product information live on the public hosts below.

- Documentation index: https://docs.millionsend.com/llms.txt
- Full documentation in one file: https://docs.millionsend.com/llms-full.txt
- Product site: https://millionsend.com/llms.txt
`;

export function GET(): Response {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
