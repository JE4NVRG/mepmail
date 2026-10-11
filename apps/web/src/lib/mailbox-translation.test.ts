import { afterEach, describe, expect, it } from "vitest";
import {
  browserTranslation,
  sameLanguage,
  translationChunks,
  translationTarget,
} from "./mailbox-translation";

describe("browser translator", () => {
  const scope = globalThis as { Translator?: unknown; LanguageDetector?: unknown };
  afterEach(() => {
    delete scope.Translator;
    delete scope.LanguageDetector;
  });

  it("is offered only where the browser has one", () => {
    expect(browserTranslation()).toBeNull();
    scope.Translator = { create: async () => ({}), availability: async () => "available" };
    expect(browserTranslation()?.detector).toBeNull();
    scope.LanguageDetector = { create: async () => ({}) };
    expect(browserTranslation()?.detector).not.toBeNull();
    scope.Translator = { create: async () => ({}) };
    expect(browserTranslation()).toBeNull();
  });
});

describe("languages", () => {
  it("translates into the page's language family", () => {
    expect(translationTarget("pt-BR")).toBe("pt");
    expect(translationTarget("en")).toBe("en");
    expect(sameLanguage("pt", "pt-BR")).toBe(true);
    expect(sameLanguage("en-US", "pt")).toBe(false);
  });
});

describe("translationChunks", () => {
  it("keeps short paragraphs together and drops empty ones", () => {
    expect(translationChunks("Hi Jean,\n\n\n\nThanks for the call.\n\nBest,\nMaya")).toEqual([
      "Hi Jean,\n\nThanks for the call.\n\nBest,\nMaya",
    ]);
    expect(translationChunks("  \n\n ")).toEqual([]);
  });

  it("splits long text at sentence ends, never past the limit", () => {
    const sentence = "This is a sentence about the contract. ";
    const long = sentence.repeat(20).trim();
    const chunks = translationChunks(`${long}\n\nShort tail.`, 200);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("Short tail.");
    expect(chunks[0]?.endsWith(".")).toBe(true);
  });

  it("cuts a single word-wall that has no sentence end", () => {
    const wall = "x".repeat(450);
    const chunks = translationChunks(wall, 200);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
  });
});
