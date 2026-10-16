import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_CLIENT_NAMESPACES,
  publicClientMessages,
  SERVER_ONLY_NAMESPACES,
} from "../src/lib/client-messages";

const src = fileURLToPath(new URL("../src/", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return undefined;
  const base = specifier.startsWith("@/")
    ? join(src, specifier.slice(2))
    : resolve(dirname(from), specifier.replace(/\.js$/, ""));
  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((suffix) => `${base}${suffix}`)
    .find((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/** Follow the actual local import tree, including lazy imports and client descendants. */
function translationReaders(path: string, seen = new Set<string>()): string[] {
  if (seen.has(path)) return [];
  seen.add(path);
  const source = withoutComments(readFileSync(path, "utf8"));
  const problems: string[] = [];
  const names = [
    "useTranslations",
    ...[...source.matchAll(/useTranslations\s+as\s+(\w+)/g)].map((match) => match[1] ?? ""),
  ];
  for (const name of names) {
    for (const call of source.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*([^)]*)\\)`, "g"))) {
      const namespace = /^["'`]([^"'`]+)/.exec(call[1] ?? "")?.[1]?.split(".")[0];
      if (!PUBLIC_CLIENT_NAMESPACES.some((allowed) => allowed === namespace)) {
        problems.push(`${relative(src, path)} reads ${namespace ?? "a dynamic/global catalog"}`);
      }
    }
  }
  const imports = [
    ...source.matchAll(/^import\s+(?!type\b)[^;]+?\sfrom\s+["']([^"']+)["'];?/gm),
    ...source.matchAll(/^export\s+(?!type\b)[^;]+?\sfrom\s+["']([^"']+)["'];?/gm),
    ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ];
  for (const entry of imports) {
    const target = resolveImport(path, entry[1] ?? "");
    if (target?.startsWith(src)) problems.push(...translationReaders(target, seen));
  }
  return problems;
}

describe("messages sent to the browser", () => {
  it("leaves out only namespaces no component reads with useTranslations", () => {
    const readers = files(src).filter((path) =>
      [...SERVER_ONLY_NAMESPACES].some((ns) =>
        new RegExp(`useTranslations\\(\\s*["'\`]${ns}["'.\`]`).test(readFileSync(path, "utf8")),
      ),
    );
    expect(readers).toEqual([]);
  });

  it("covers every client translation reader in public/auth route import trees and root error UI", () => {
    const app = join(src, "app");
    const pages = files(app).filter((path) => /[\\/]page\.tsx$/.test(path));
    const scoped = pages.filter((path) => {
      const route = `/${relative(app, path)
        .replace(/[\\/]?page\.tsx$/, "")
        .replaceAll("\\", "/")
        .replace(/\[[^/]+\]/g, "example")}`;
      return publicClientMessages(route.replace(/\/$/, "") || "/", "en") !== undefined;
    });
    expect(scoped.length).toBeGreaterThanOrEqual(23);
    const problems = scoped.flatMap((path) => translationReaders(path));
    problems.push(
      ...translationReaders(join(app, "layout.tsx")),
      ...translationReaders(join(app, "error.tsx")),
    );
    expect([...new Set(problems)]).toEqual([]);
  });

  it("uses one static public/auth union per locale and keeps private, OAuth and unknown fallbacks", () => {
    const english = publicClientMessages("/signup?next=%2Femails", "en");
    expect(Object.keys(english ?? {}).sort()).toEqual([...PUBLIC_CLIENT_NAMESPACES].sort());
    expect(publicClientMessages("/", "en")).toBe(english);
    expect(publicClientMessages("/guides/getting-started", "en")).toBe(english);
    expect(publicClientMessages("/pricing/", "pt-BR")).not.toBe(english);
    for (const path of [
      null,
      undefined,
      "https://evil.test",
      "//evil.test",
      "/emails",
      "/mailboxes",
      "/console",
      "/oauth/consent",
      "/invite/token",
      "/onboarding",
      "/fixture-mail/migration",
      "/unknown-route",
    ]) {
      expect(publicClientMessages(path, "en")).toBeUndefined();
    }
    expect(publicClientMessages("/", "unsupported")).toBeUndefined();
  });

  it("keeps current public/auth-to-dashboard entries as document navigation", () => {
    expect(readFileSync(join(src, "components/auth/auth-form.tsx"), "utf8")).toContain(
      "window.location.assign(next)",
    );
    expect(readFileSync(join(src, "components/public-account.tsx"), "utf8")).toMatch(
      /<a\s[^>]*href="\/emails"/,
    );
    expect(readFileSync(join(src, "components/signup-cta.tsx"), "utf8")).toMatch(
      /<a\s[^>]*href=\{signupHref/,
    );
  });

  it("reduces the serialized public translation boundary by at least 75% in both locales", () => {
    const requestSource = readFileSync(join(src, "i18n/request.ts"), "utf8");
    const list = /const NAMESPACES = \[([\s\S]*?)\] as const/.exec(requestSource)?.[1] ?? "";
    const namespaces = [...list.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "");
    for (const locale of ["en", "pt-BR"]) {
      const oldMessages = Object.fromEntries(
        namespaces
          .filter((ns) => !SERVER_ONLY_NAMESPACES.has(ns))
          .map((ns) => [
            ns,
            JSON.parse(readFileSync(join(src, `../messages/${locale}/${ns}.json`), "utf8")),
          ]),
      );
      const before = Buffer.byteLength(JSON.stringify(oldMessages));
      const after = Buffer.byteLength(JSON.stringify(publicClientMessages("/", locale)));
      expect(after).toBeLessThan(before * 0.25);
    }
  });
});
