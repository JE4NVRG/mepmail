import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { beginSendCheckout } from "../src/send-checkout.js";
import { fundedSaleCapacity } from "./financial-controls-fixture.js";
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
      "invalid",
    );
    expect(f.posts).toEqual([]);
  } finally {
    await f.close();
  }
});

it("still enforces real capacity for a supported new purchase with fresh regional shortage", async () => {
  const f = await checkoutFixture();
  try {
    await expect(
      beginSendCheckout(
        {
          ...f.deps,
          capacitySource: async () => {
            const observed = await fundedSaleCapacity();
            const current = observed.capacityReceipt;
            if (!current) throw new Error("fixture requires a complete fresh regional receipt");
            const receipt = {
              ...current,
              observations: { ...current.observations, sesSentLast24Hours: 999000 },
              buffers: { ...current.buffers, sesRemaining24Hours: (1000000 - 999000) * 0.98 },
            };
            return {
              ...observed,
              capacityReceipt: receipt,
              regionalCapacity: {
                "us-east-1": receipt,
                "eu-west-1": observed.regionalCapacity?.["eu-west-1"] ?? null,
              },
            };
          },
        },
        f.input,
      ),
    ).rejects.toThrow("capacity_insufficient");
    expect(f.posts).toEqual([]);
    expect(
      (await f.db.select().from(schema.auditLog)).filter(
        (row) => row.action === "sending.sale_reserved",
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
