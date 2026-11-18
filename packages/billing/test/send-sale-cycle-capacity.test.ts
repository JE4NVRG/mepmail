import { createTeam, createTestDb } from "@millionsend/test-utils";
import { expect, it } from "vitest";
import { assertSendSaleCapacity, captureSendSaleCapacity } from "../src/send-sale-capacity.js";
import { fundedSaleCapacity } from "./financial-controls-fixture.js";

it("checks an unsigned Pro purchase against the shortest regular cycle", async () => {
  const { db, close } = await createTestDb();
  try {
    const teamId = await createTeam(db, "pro-short-cycle");
    const check = async (globalDaily: number) => {
      const observation = await captureSendSaleCapacity(async () => {
        const fixture = await fundedSaleCapacity();
        const receipt = fixture.regionalCapacity?.["us-east-1"];
        if (!receipt) throw new Error("Missing synthetic commercial capacity receipt");
        return {
          ...fixture,
          regionalCapacity: {
            "us-east-1": { ...receipt, globalDaily },
            "eu-west-1": null,
          },
        };
      });
      return db.transaction((tx) => assertSendSaleCapacity(tx, teamId, "pro_100k", observation));
    };

    await expect(check(3_928)).rejects.toMatchObject({ reason: "capacity_insufficient" });
    await expect(check(3_929)).resolves.toBeUndefined();
  } finally {
    await close();
  }
});
