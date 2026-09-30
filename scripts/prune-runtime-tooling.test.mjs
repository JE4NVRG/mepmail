import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pruneRuntimeTooling } from "./prune-runtime-tooling.mjs";

test("removes only optional development toolkits and preserves runtime dependencies", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".p0-tooling-test-"));
  const store = path.join(root, "node_modules/.pnpm");
  const remove = ["vitest@5.0.0_peer", "@vitest+expect@5.0.0", "drizzle-kit@0.31.10"];
  const keep = ["tsx@4.23.13", "drizzle-orm@0.45.2", "better-auth@1.7.2", "next@16.3.4"];
  try {
    for (const name of [...remove, ...keep]) fs.mkdirSync(path.join(store, name), { recursive: true });
    assert.deepEqual(pruneRuntimeTooling(root).sort(), remove.sort());
    assert.deepEqual(fs.readdirSync(store).sort(), keep.sort());
    assert.deepEqual(pruneRuntimeTooling(root), []);
  } finally {
    // Diretório descartável criado exclusivamente por este teste.
    fs.rmSync(root, { recursive: true });
  }
});
