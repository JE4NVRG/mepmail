import type { JudgeTelemetry } from "@millionsend/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";

const SECRET = "SECRET_CONTENT_SENTINEL";
const valid = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ is_abuse: 0, category: "clean", language: "en" }) },
        },
      ],
    }),
  );
const signal = () => new AbortController().signal;
const abort = (name: string) => new DOMException(SECRET, name);
const make = (fetch: () => Promise<Response>) =>
  createOpenAiJudge({
    model: SECRET,
    baseUrl: "https://offline.example.test",
    apiKey: SECRET,
    fetch,
  });
afterEach(() => vi.restoreAllMocks());
describe("judge phase telemetry", () => {
  it.each(["AbortError", "TimeoutError"])(
    "classifies %s before headers without inventing completed timings",
    async (name) => {
      const events: JudgeTelemetry[] = [];
      await expect(
        make(async () => {
          throw abort(name);
        }).judge(SECRET, {
          signal: signal(),
          onTelemetry: (event) => {
            events.push(event);
          },
        }),
      ).rejects.toMatchObject({ class: "timeout" });
      expect(events).toEqual([
        { phase: "headers", errorClass: "timeout", elapsedMs: expect.any(Number) },
      ]);
      expect(JSON.stringify(events)).not.toContain(SECRET);
    },
  );
  it.each(
    [200, 401, 429, 503].flatMap((status) =>
      ["AbortError", "TimeoutError"].map((name) => [status, name] as const),
    ),
  )("classifies an aborted body after HTTP %s (%s) as timeout", async (status, name) => {
    const events: JudgeTelemetry[] = [];
    const res = new Response(null, { status });
    vi.spyOn(res, status === 200 ? "json" : "text").mockRejectedValue(abort(name));
    await expect(
      make(async () => res).judge(SECRET, {
        signal: signal(),
        onTelemetry: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ class: "timeout" });
    expect(events).toEqual([
      {
        phase: "body",
        errorClass: "timeout",
        elapsedMs: expect.any(Number),
        headersMs: expect.any(Number),
        httpStatus: status,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
  it("preserves a non-abort malformed JSON parse error and reports body failure", async () => {
    const events: JudgeTelemetry[] = [];
    await expect(
      make(async () => new Response(SECRET)).judge(SECRET, {
        signal: signal(),
        onTelemetry: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ class: "parse_error" });
    expect(events[0]).toMatchObject({ phase: "body", errorClass: "parse_error", httpStatus: 200 });
    expect(events[0]).not.toHaveProperty("bodyMs");
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
  it("reports content validation separately with completed header and body timings", async () => {
    const events: JudgeTelemetry[] = [];
    await expect(
      make(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: SECRET } }] })),
      ).judge(SECRET, {
        signal: signal(),
        onTelemetry: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ class: "parse_error" });
    expect(events).toEqual([
      {
        phase: "content",
        errorClass: "parse_error",
        elapsedMs: expect.any(Number),
        headersMs: expect.any(Number),
        bodyMs: expect.any(Number),
        httpStatus: 200,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
  it("reports complete for an unchanged clean verdict and never exposes payload fields", async () => {
    const events: JudgeTelemetry[] = [];
    const verdict = await make(async () => valid()).judge(SECRET, {
      signal: signal(),
      onTelemetry: (event) => {
        events.push(event);
      },
    });
    expect(verdict).toMatchObject({ score: 0, verdict: "clean" });
    expect(events).toEqual([
      {
        phase: "complete",
        elapsedMs: expect.any(Number),
        headersMs: expect.any(Number),
        bodyMs: expect.any(Number),
        httpStatus: 200,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0]?.elapsedMs).toBeGreaterThanOrEqual(events[0]?.headersMs ?? 0);
  });
  it("does not let a failing telemetry sink turn a good verdict into a failure", async () => {
    await expect(
      make(async () => valid()).judge(SECRET, {
        signal: signal(),
        onTelemetry: () => {
          throw new Error(SECRET);
        },
      }),
    ).resolves.toMatchObject({ score: 0, verdict: "clean" });
  });
  it.each([
    [401, "no_credentials"],
    [402, "no_credentials"],
    [403, "no_credentials"],
    [429, "throttled"],
    [529, "throttled"],
    [503, "upstream"],
    [400, "upstream"],
  ])("preserves HTTP %s mapping to %s after completed body read", async (status, errorClass) => {
    const events: JudgeTelemetry[] = [];
    await expect(
      make(async () => new Response(SECRET, { status: Number(status) })).judge(SECRET, {
        signal: signal(),
        onTelemetry: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ class: errorClass });
    expect(events[0]).toMatchObject({
      phase: "body",
      errorClass,
      httpStatus: status,
      bodyMs: expect.any(Number),
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

it("isolates an asynchronous telemetry sink rejection", async () => {
  await expect(
    make(async () => valid()).judge(SECRET, {
      signal: signal(),
      onTelemetry: async () => {
        throw new Error(SECRET);
      },
    }),
  ).resolves.toMatchObject({ score: 0, verdict: "clean" });
});
it("keeps HTTP status mapping when a non-abort error body cannot be read", async () => {
  const events: JudgeTelemetry[] = [];
  const response = new Response(null, { status: 429 });
  vi.spyOn(response, "text").mockRejectedValue(new Error(SECRET));
  await expect(
    make(async () => response).judge(SECRET, {
      signal: signal(),
      onTelemetry: (event) => {
        events.push(event);
      },
    }),
  ).rejects.toMatchObject({ class: "throttled" });
  expect(events[0]).toMatchObject({ phase: "body", httpStatus: 429, errorClass: "throttled" });
  expect(events[0]).not.toHaveProperty("bodyMs");
  expect(JSON.stringify(events)).not.toContain(SECRET);
});
