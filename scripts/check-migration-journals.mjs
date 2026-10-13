// Both migration chains (the main one and Correio's) are partly hand-written and keep no
// drizzle-kit snapshot, so CI checks their journals instead: every entry has its SQL file,
// every SQL file is journaled, and entries are numbered in order. The test suites apply
// both chains to a real database.
import { readdirSync, readFileSync } from "node:fs";

let failed = false;
const fail = (message) => {
  console.error(message);
  failed = true;
};

for (const dir of ["packages/db/drizzle", "packages/db/mailbox-drizzle"]) {
  const { entries } = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8"));
  const tags = entries.map((entry) => entry.tag);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -4));
  for (const tag of tags)
    if (!files.includes(tag)) fail(`${dir}: ${tag} is journaled but has no SQL file`);
  for (const file of files)
    if (!tags.includes(file)) fail(`${dir}: ${file}.sql is not in the journal`);
  entries.forEach((entry, index) => {
    if (entry.idx !== index || !entry.tag.startsWith(`${String(index).padStart(4, "0")}_`))
      fail(`${dir}: entry ${index} is ${entry.tag} (idx ${entry.idx})`);
  });
  console.log(`${dir}: ${entries.length} migrations`);
}

process.exit(failed ? 1 : 0);
