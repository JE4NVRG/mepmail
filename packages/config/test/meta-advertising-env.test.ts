import { describe, expect, it } from "vitest";
import { assertEnvConsistency, type Env } from "../src/env.js";

const fakeEnv = (fields: Record<string, string | boolean> = {}) =>
  ({ IS_CLOUD: false, ...fields }) as unknown as Env;

describe("optional Meta server transport", () => {
  it.each([{}, { META_CONVERSIONS_ENABLED: false }, { META_CONVERSIONS_ENABLED: "false" }])(
    "does not require credentials while disabled: %j",
    (fields) => expect(() => assertEnvConsistency(fakeEnv(fields))).not.toThrow(),
  );

  it.each([true, "true", "1"])("requires explicit configuration for enabled=%s", (flag) => {
    const fields: Record<string, string | boolean> = { META_CONVERSIONS_ENABLED: flag };
    for (const [key, value] of [
      ["META_DATASET_ID", "1418150576403119"],
      ["META_ACCESS_TOKEN", "fixture-not-a-credential"],
      ["META_GRAPH_API_VERSION", "v25.0"],
    ]) {
      expect(() => assertEnvConsistency(fakeEnv(fields))).toThrow(
        `META_CONVERSIONS_ENABLED=true requires ${key}`,
      );
      fields[key] = value;
    }
    expect(() => assertEnvConsistency(fakeEnv(fields))).not.toThrow();
  });
});
