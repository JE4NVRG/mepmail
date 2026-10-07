import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getSkill } from "../mepmail/SKILL.md/route";
import { GET } from "./route";

describe("agent-skills index", () => {
  it("advertises the MepMail skill in the agentskills.io shape", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills).toHaveLength(1);
    const [skill] = body.skills;
    expect(skill.name).toBe("mepmail");
    expect(skill.type).toBe("skill-md");
    expect(skill.description).toMatch(/^Use when /);
    expect(skill.url).toBe("https://mepmail.dev/.well-known/agent-skills/mepmail/SKILL.md");
  });

  it("publishes the digest of the bytes the SKILL.md route actually serves", async () => {
    const body = await GET().json();
    const markdown = await getSkill().text();
    const digest = `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
    expect(body.skills[0].digest).toBe(digest);
  });

  it("serves a skill that points only at surfaces we publish", async () => {
    const res = getSkill();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const markdown = await res.text();
    // Frontmatter the convention expects, and the loop back to the docs.
    expect(markdown.startsWith("---\nname: mepmail\n")).toBe(true);
    for (const url of [
      "https://docs.mepmail.dev/errors",
      "https://docs.mepmail.dev/rate-limits",
      "https://docs.mepmail.dev/mcp",
      "https://docs.mepmail.dev/packages",
      "https://api.mepmail.dev/openapi.json",
      "https://mepmail.dev/auth.md",
      "https://api.mepmail.dev/mcp/correio",
      "https://docs.mepmail.dev/mailboxes",
    ]) {
      expect(markdown).toContain(url);
    }
    // Agents learn the approval path instead of retrying around it.
    expect(markdown).toContain("awaiting_approval");
    // The old brand must never appear in a machine-readable surface.
    expect(markdown.toLowerCase()).not.toContain("millionsend");
  });
});
