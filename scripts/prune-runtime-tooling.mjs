import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tooling = /^(?:vitest|@vitest\+[^@]+|drizzle-kit|@biomejs\+biome|turbo)@/;

export function pruneRuntimeTooling(root) {
  const store = path.join(root, "node_modules/.pnpm");
  const removed = [];
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || !tooling.test(entry.name)) continue;
    // Somente toolkits conhecidos no store desta imagem descartável.
    const target = path.join(store, entry.name);
    fs.rmSync(target, { recursive: true });
    removed.push(entry.name);
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const removed = pruneRuntimeTooling(process.cwd());
  console.log(JSON.stringify({ removedOptionalDevelopmentToolkits: removed }));
}
