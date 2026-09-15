import { GetAccountCommand, PutAccountPricingAttributesCommand } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setColorMode } from "../../cli/src/theme.js";
import type { LineReader } from "../../cli/src/tty-ui.js";
import { authAction, essentialsPlanPrompt, main } from "../src/setup-cli.js";

describe("main --dry-run", () => {
  afterEach(() => {
    setColorMode("auto");
    vi.restoreAllMocks();
  });

  async function captured(): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    expect(await main(["--dry-run"])).toBe(0);
    return lines.join("\n");
  }

  it("prints plain bytes when color is off", async () => {
    setColorMode("never");
    const out = await captured();
    expect(out).toContain("\nPlan:\n");
    expect(out).not.toContain("\x1b");
  });

  it("bolds the section title when color is on", async () => {
    setColorMode("always");
    expect(await captured()).toContain("\x1b[1mPlan:\x1b[22m");
  });
});

describe("authAction", () => {
  it("proceeds when the identity check passed", () => {
    expect(authAction({ identityOk: true, hasAwsCli: false, isTTY: false })).toBe("proceed");
  });

  it("offers a login only on a TTY with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: true })).toBe("offer-login");
  });

  it("hints and exits on pipes even with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: false })).toBe("hint-exit");
  });

  it("hints and exits on a TTY without the aws CLI", () => {
    expect(authAction({ identityOk: false, hasAwsCli: false, isTTY: true })).toBe("hint-exit");
  });
});

describe("essentialsPlanPrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeSes(plan: string | null | Error) {
    const calls: object[] = [];
    return {
      calls,
      ses: {
        send: async (command: object) => {
          calls.push(command);
          if (plan instanceof Error) throw plan;
          return command instanceof GetAccountCommand
            ? { PricingAttributes: { CurrentPlan: plan ?? undefined } }
            : {};
        },
      },
    };
  }
  const answering = (answer: string): LineReader =>
    ({ question: async () => answer, close: () => {} }) as unknown as LineReader;

  it("cancels only on an explicit yes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const yes = fakeSes("ESSENTIALS");
    expect(await essentialsPlanPrompt(answering("y"), yes.ses, "us-east-1")).toBe("cancelled");
    const cancel = yes.calls.find((c) => c instanceof PutAccountPricingAttributesCommand);
    expect(cancel).toMatchObject({ input: { Plan: "NONE" } });

    for (const answer of ["", "n", "maybe"]) {
      const kept = fakeSes("ESSENTIALS");
      expect(await essentialsPlanPrompt(answering(answer), kept.ses, "us-east-1")).toBe("kept");
      expect(kept.calls.some((c) => c instanceof PutAccountPricingAttributesCommand)).toBe(false);
    }
  });

  it("asks nothing on à la carte, and leaves an unreadable plan alone", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const question = vi.fn(async () => "y");
    const rl = { question, close: () => {} } as unknown as LineReader;
    const none = fakeSes("NONE");
    expect(await essentialsPlanPrompt(rl, none.ses, "us-east-1")).toBe("not_essentials");
    const down = fakeSes(new Error("throttled"));
    expect(await essentialsPlanPrompt(rl, down.ses, "us-east-1")).toBe("unknown");
    expect(question).not.toHaveBeenCalled();
    expect(none.calls).toHaveLength(1);
  });
});
