import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { teamFunnelProps } from "../src/funnel-events.js";

it("uses actual catalog plan codes and retains the team tier without collapsing paid rungs", async () => {
  const { db, close } = await createTestDb();
  try {
    const cases = [
      { plan: "free", quota: null, code: "free" },
      { plan: "starter", quota: null, code: "starter" },
      { plan: "pro", quota: 110_000, code: "pro_100k" },
      { plan: "pro", quota: 220_000, code: "pro_200k" },
      { plan: "scale", quota: 550_000, code: "scale_500k" },
      { plan: "system", quota: null, code: "system" },
    ] as const;
    for (const row of cases) {
      const id = await createTeam(db, `${row.plan}-${row.quota ?? "none"}`);
      await db
        .update(schema.teams)
        .set({ plan: row.plan, planQuota: row.quota })
        .where(eq(schema.teams.id, id));
      const props = await teamFunnelProps(db, id);
      expect(props.plan).toBe(row.code);
      expect(props.plan_tier).toBe(row.plan);
      expect(props.team_id).toBe(id);
      expect(props.bot_status).toBe("unknown");
      expect(props.is_qa).toBe("unknown");
    }
    expect(await db.select().from(schema.funnelEvents)).toEqual([]);
  } finally {
    await close();
  }
});
