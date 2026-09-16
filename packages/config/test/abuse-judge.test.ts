import { expect, it } from "vitest";
import { abuseJudgeConfig, assertEnvConsistency, type Env } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean | number>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

it("is off by default and needs nothing else then", () => {
  expect(abuseJudgeConfig(fakeEnv({}))).toBeNull();
  expect(abuseJudgeConfig(fakeEnv({ ABUSE_JUDGE: "off" }))).toBeNull();
  expect(() => assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "off" }))).not.toThrow();
});

it("requires a model for every provider and a key for the hosted ones", () => {
  expect(() => assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "bedrock" }))).toThrow(
    "ABUSE_JUDGE=bedrock requires ABUSE_JUDGE_MODEL",
  );
  expect(() =>
    assertEnvConsistency(
      fakeEnv({ ABUSE_JUDGE: "bedrock", ABUSE_JUDGE_MODEL: "amazon.nova-lite-v1:0" }),
    ),
  ).not.toThrow();
  expect(() =>
    assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "openai", ABUSE_JUDGE_MODEL: "gpt-5-nano" })),
  ).toThrow("ABUSE_JUDGE=openai requires ABUSE_JUDGE_API_KEY");
  expect(() =>
    assertEnvConsistency(
      fakeEnv({
        ABUSE_JUDGE: "anthropic",
        ABUSE_JUDGE_MODEL: "claude-haiku-4-5",
        ABUSE_JUDGE_API_KEY: "k",
      }),
    ),
  ).not.toThrow();
});

it("reads the judge's settings with their defaults, validated or raw", () => {
  expect(
    abuseJudgeConfig(
      fakeEnv({
        ABUSE_JUDGE: "bedrock",
        ABUSE_JUDGE_MODEL: "amazon.nova-lite-v1:0",
        ABUSE_JUDGE_TIMEOUT_MS: "5000",
      }),
    ),
  ).toEqual({
    provider: "bedrock",
    model: "amazon.nova-lite-v1:0",
    region: "us-east-1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: undefined,
    timeoutMs: 5000,
  });
  expect(
    abuseJudgeConfig(
      fakeEnv({
        ABUSE_JUDGE: "openai",
        ABUSE_JUDGE_MODEL: "gpt-5-nano",
        ABUSE_JUDGE_API_KEY: "k",
        ABUSE_JUDGE_BASE_URL: "https://llm.example.com/v1",
        ABUSE_JUDGE_REGION: "",
      }),
    ),
  ).toMatchObject({
    provider: "openai",
    baseUrl: "https://llm.example.com/v1",
    region: "us-east-1",
    timeoutMs: 20_000,
  });
});
