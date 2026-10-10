import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_ONLY_NAMESPACES } from "../src/lib/client-messages";

const src = fileURLToPath(new URL("../src/", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
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
});
