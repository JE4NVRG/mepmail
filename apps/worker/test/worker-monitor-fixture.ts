import { ABUSE_JUDGE_QUESTIONS } from "@millionsend/core";

/** Synthetic HTTP boundary only. Explicit answers: a new Core question must
 * fail this fixture until its clean meaning has been reviewed, never default it. */
export function workerMonitorJudgeFrame(answers: Record<string, unknown>) {
  const expected = Object.keys(ABUSE_JUDGE_QUESTIONS).sort();
  const actual = Object.keys(answers).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Worker monitor fixture does not match the Core judge contract");
  }
  return {
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answers) } }],
    // Synthetic provider usage, not a claim of measured provider consumption.
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}
