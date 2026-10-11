// Retention after a verified desktop release (README "Releasing an update").
// Keeps the current version's installer, its .sig and its Store package, and
// removes what the next build regenerates: target/debug, the release build's
// intermediates, bundles and MSIX packages of other versions, the MSIX layout
// and the WebView2 profiles of throwaway test installs. Idempotent; prints
// what it removed and how much. Never touches the installed app's profile.
//   npm run retain            (or: node scripts/retain.mjs --dry-run)
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const dry = process.argv.includes("--dry-run");
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const target = join(root, "src-tauri", "target");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

function size(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
}
let freed = 0;
function remove(path) {
  if (!existsSync(path)) return;
  const bytes = size(path);
  freed += bytes;
  console.log(`${dry ? "would remove" : "removed"} ${path} (${(bytes / 2 ** 20).toFixed(1)} MB)`);
  if (!dry) rmSync(path, { recursive: true, force: true });
}
const others = (dir, keep) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => !keep(name))
        .map((name) => join(dir, name))
    : [];

remove(join(target, "debug"));
for (const path of others(join(target, "release"), (name) => name === "bundle")) remove(path);
for (const path of others(join(target, "release", "bundle"), (name) => name === "nsis"))
  remove(path);
for (const path of others(join(target, "release", "bundle", "nsis"), (name) =>
  name.includes(`_${version}_`),
))
  remove(path);
for (const path of others(join(target, "msix"), (name) => name.includes(`_${version}.0_`)))
  remove(path);
// Throwaway identities from the README's local tests (dev.mepmail.correio.<test>).
const local = process.env.LOCALAPPDATA;
if (local)
  for (const name of readdirSync(local).filter((entry) =>
    /^dev\.mepmail\.correio\.[a-z0-9-]+$/.test(entry),
  ))
    remove(join(local, name));

console.log(`${dry ? "would free" : "freed"} ${(freed / 2 ** 30).toFixed(2)} GB; kept ${version}`);
