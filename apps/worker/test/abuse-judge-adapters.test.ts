import { ABUSE_JUDGE_POLICY, ABUSE_JUDGE_QUESTIONS, JudgeError } from "@millionsend/core";
import { expect, it } from "vitest";
import { createAbuseJudge } from "../src/abuse-judge/index.js";
import { createTypesafeJudge } from "../src/abuse-judge/typesafe.js";

const answers = {
  is_abuse: { type: "noul", noul: 0.88 },
  impersonation: { type: "noul", noul: 0.91 },
  category: { type: "choice", choice: "brand_impersonation" },
  language: { type: "choice", choice: "en" },
};

it("posts state and typed questions, then composes the verdict", async () => {
  let posted: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
  const judge = createTypesafeJudge({
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    apiKey: "k",
    fetch: async (url, init) => {
      posted = {
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      };
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await expect(
    judge.judge("Team name: Acme\nFrom: Bank <a@x.example>", {
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({
    score: 88,
    verdict: "abuse",
    categories: ["brand_impersonation"],
    reasons: ["impersonation"],
    language: "en",
  });
  expect(posted).toMatchObject({
    url: "https://api.typesafe.ai/v1/systemone",
    auth: "Bearer k",
  });
  expect(posted?.body).toMatchObject({
    model: "jev-latest",
    questions: ABUSE_JUDGE_QUESTIONS,
    state: { policy: ABUSE_JUDGE_POLICY, email: "Team name: Acme\nFrom: Bank <a@x.example>" },
  });
});

it("classes HTTP failures and a missing key", async () => {
  const judge = (status: number) =>
    createTypesafeJudge({
      model: "jev-latest",
      baseUrl: "https://api.typesafe.ai/",
      apiKey: "k",
      fetch: async () => new Response("nope", { status }),
    });
  await expect(
    judge(401).judge("x", { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ class: "no_credentials" });
  await expect(
    judge(429).judge("x", { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ class: "throttled" });
  await expect(
    judge(529).judge("x", { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ class: "throttled" });
  await expect(
    judge(500).judge("x", { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ class: "upstream" });
  const noKey = createTypesafeJudge({
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    apiKey: undefined,
    fetch: async () => {
      throw new Error("should not fetch");
    },
  });
  await expect(noKey.judge("x", { signal: new AbortController().signal })).rejects.toBeInstanceOf(
    JudgeError,
  );
});

it("is a parse error when the body has no is_abuse noul", async () => {
  const judge = createTypesafeJudge({
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    apiKey: "k",
    fetch: async () =>
      new Response(JSON.stringify({ answers: { impersonation: { type: "noul", noul: 0.9 } } }), {
        status: 200,
      }),
  });
  await expect(judge.judge("x", { signal: new AbortController().signal })).rejects.toMatchObject({
    class: "parse_error",
  });
});

it("createAbuseJudge is null when off and TypeSafe when on", () => {
  expect(createAbuseJudge(null)).toBeNull();
  expect(
    createAbuseJudge({
      provider: "typesafe",
      model: "jev-latest",
      baseUrl: "https://api.typesafe.ai",
      apiKey: "k",
      timeoutMs: 20_000,
    }),
  ).toMatchObject({ provider: "typesafe", model: "jev-latest" });
});
