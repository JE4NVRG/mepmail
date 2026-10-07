import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveInternalActorKey,
  signInternalActor,
  verifyInternalActor,
} from "../src/internal-actor.js";

describe("internal actor", () => {
  const key = deriveInternalActorKey(randomBytes(32));
  const actor = { teamId: "team-1", userId: "user-1" };

  it("round-trips a fresh statement", () => {
    expect(verifyInternalActor(key, signInternalActor(key, actor))).toMatchObject(actor);
  });

  it("refuses another key, a tampered payload and an expired statement", () => {
    const signed = signInternalActor(key, actor);
    expect(verifyInternalActor(deriveInternalActorKey(randomBytes(32)), signed)).toBeNull();
    const [payload, sig] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...actor, userId: "admin", exp: 9e9 })).toString(
      "base64url",
    );
    expect(verifyInternalActor(key, `${forged}.${sig}`)).toBeNull();
    expect(verifyInternalActor(key, `${payload}.${sig}.x`)).toBeNull();
    expect(
      verifyInternalActor(key, signInternalActor(key, actor, Date.now() - 120_000)),
    ).toBeNull();
    expect(verifyInternalActor(key, null)).toBeNull();
  });
});
