// Retention after a verified desktop release (README "Releasing an update").
// Keeps the current version's installer, its .sig and its Store package, and
// removes what the next build regenerates: target/debug, the release build's
// intermediates, bundles and MSIX packages of other versions, the MSIX layout
// and the WebView2 profiles of throwaway test installs. Idempotent; prints
// what it removed and how much. Never touches the installed app's profile.
//   npm run retain            (or: node scripts/retain.mjs --dry-run)
//   npm run retain -- --caches-only [--dry-run]
// Cache-only mode preserves every installer, bundle, MSIX and app profile.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const flags = new Set(["--dry-run", "--caches-only"]);
for (const flag of process.argv.slice(2))
  if (!flags.has(flag)) throw new Error(`Unknown retention option: ${flag}`);
const dry = process.argv.includes("--dry-run");
const cachesOnly = process.argv.includes("--caches-only");
const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "src-tauri", "target");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

function assertCachePath(path) {
  const absolute = resolve(path);
  const rel = relative(resolve(root), absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`Cache outside desktop source: ${path}`);
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    if (lstatSync(ancestor).isSymbolicLink())
      throw new Error(`Link or junction in cache path: ${ancestor}`);
    if (ancestor === resolve(root)) break;
  }
  if (relative(realpathSync(root), realpathSync(absolute)) !== rel)
    throw new Error(`Unexpected resolved cache path: ${path}`);
}

function cacheSize(path) {
  const stat = lstatSync(path);
  const name = basename(path);
  if (stat.isSymbolicLink()) throw new Error(`Link or junction in cache: ${path}`);
  if (stat.isDirectory()) {
    if (name.toLowerCase() === "bundle" || name.toLowerCase().endsWith(".app"))
      throw new Error(`Protected app package inside cache: ${path}`);
    return readdirSync(path).reduce((total, name) => total + cacheSize(join(path, name)), 0);
  }
  if (!stat.isFile()) throw new Error(`Unsupported cache entry: ${path}`);
  if (
    /\.(?:msix|appimage|deb|rpm|dmg|pkg|msi|aab|apk|zip|tar|tgz|gz|xz|7z)(?:\.sig)?$/i.test(name) ||
    /1\.0\.[23].*\.exe(?:\.sig)?$/i.test(name)
  )
    throw new Error(`Protected app package inside cache: ${path}`);
  return stat.size;
}

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

if (cachesOnly) {
  // Validate every entry before deleting anything. Only these regenerable
  // Cargo directories are eligible; release binaries and bundles stay intact.
  const paths = [
    "debug",
    "aarch64-linux-android",
    "release/.fingerprint",
    "release/build",
    "release/deps",
    "release/examples",
    "release/incremental",
  ].map((name) => join(target, name));
  const plan = [];
  for (const path of paths) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assertCachePath(path);
    if (!lstatSync(path).isDirectory()) throw new Error(`Cache is not a directory: ${path}`);
    plan.push({ path, bytes: cacheSize(path) });
  }
  for (const { path, bytes } of plan) {
    console.log(`${dry ? "would remove" : "removed"} ${path} (${(bytes / 2 ** 20).toFixed(1)} MB)`);
    if (!dry) rmSync(path, { recursive: true, force: false });
    freed += bytes;
  }
} else {
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
}

console.log(
  `${dry ? "would remove" : "removed"} ${(freed / 2 ** 30).toFixed(2)} GiB of files; ${cachesOnly ? "all app packages and profiles preserved" : `kept ${version}`}`,
);
