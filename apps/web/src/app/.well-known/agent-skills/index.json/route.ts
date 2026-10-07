import { skillDigest } from "../skill";

/**
 * Agent skills index: the discovery document an agent fetches to learn which
 * skills this host publishes, per the agentskills.io convention (schema 0.2.0,
 * the shape Postmark and Resend publish).
 *
 * Served at /.well-known/agent-skills/index.json. The digest is computed from
 * the very markdown the SKILL.md route returns (see ../skill.ts), so the two
 * cannot drift apart, and the test next to this file fails if they ever do.
 *
 * Keep it short: the index points at the skill, the skill points at the docs.
 */
const BODY = JSON.stringify(
  {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "mepmail",
        type: "skill-md",
        description:
          "Use when sending or managing transactional email with MepMail, or giving an AI agent its own inbox with Correio: the Resend-compatible API, the hosted, local and Correio MCP servers, the migration CLI, quotas, rate limits and delivery failures.",
        url: "https://mepmail.je4ndev.com/.well-known/agent-skills/mepmail/SKILL.md",
        digest: skillDigest(),
      },
    ],
  },
  null,
  2,
);

export function GET(): Response {
  return new Response(BODY, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
