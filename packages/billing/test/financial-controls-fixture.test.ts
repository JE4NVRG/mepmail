import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { beginSendCheckout } from "../src/send-checkout.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

it("funded server fixture admits the original monthly contract without bypassing the gate", async () => {
  const f = await checkoutFixture();
  try {
    await beginSendCheckout(f.deps, f.input);
    expect(f.posts.map((p) => p.kind)).toEqual(["customer", "session"]);
  } finally {
    await f.close();
  }
});

it("unknown capacity is still denied before any financial POST", async () => {
  const f = await checkoutFixture();
  try {
    await expect(
      beginSendCheckout(
        {
          ...f.deps,
          capacitySource: async () => {
            throw new Error("unknown");
          },
        },
        f.input,
      ),
    ).rejects.toThrow("capacity_unknown");
    expect(f.posts).toEqual([]);
  } finally {
    await f.close();
  }
});

it("partial Native history remains denied, never silently counted as zero", async () => {
  const f = await checkoutFixture();
  try {
    await f.db.execute(sql`drop table mailbox_outbound_outcomes`);
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toThrow(
      "native_reputation_schema_partial",
    );
    expect(f.posts).toEqual([]);
  } finally {
    await f.close();
  }
});

it("the valid three-RPM fixture still refuses an oversized new commitment", async () => {
  const f = await checkoutFixture();
  try {
    await expect(beginSendCheckout(f.deps, { ...f.input, rung: "pro_200k" })).rejects.toThrow(
      "capacity_insufficient",
    );
    expect(f.posts).toEqual([]);
  } finally {
    await f.close();
  }
});
