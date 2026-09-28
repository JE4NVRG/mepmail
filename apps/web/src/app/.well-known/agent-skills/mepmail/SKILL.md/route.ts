import { MEPMAIL_SKILL_MD } from "../../skill";

/**
 * The SKILL.md body itself, served as markdown at
 * /.well-known/agent-skills/mepmail/SKILL.md and advertised by the index next
 * to it. The text lives in ../skill.ts so the index's digest and these bytes
 * are the same string.
 */
export function GET(): Response {
  return new Response(MEPMAIL_SKILL_MD, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
