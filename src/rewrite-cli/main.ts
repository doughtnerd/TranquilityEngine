/**
 * `npm run rewrite`: rewrite a project's scene and prefab files to the latest format version (ADR 0013).
 *
 * ```sh
 * npm run rewrite -- <projectDir> [--check] [--dry-run]
 * ```
 *
 * Walks the project for `*.scene.json` and `*.prefab.json`, migrates outdated ones and writes them
 * back in the editor's layout; files already at the latest version aren't touched. `--dry-run`
 * reports what would change without writing; `--check` does the same and exits 1 if any file is outdated.
 *
 * Exits 0 on success, 1 if a file couldn't be migrated (or, with `--check`, is outdated), 2 for bad arguments.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSceneOrPrefabPath, rewriteProjectFiles } from "./rewrite";

export const USAGE = `Usage: npm run rewrite -- <projectDir> [options]

Rewrites the project's *.scene.json and *.prefab.json files to the latest format version.

Options:
  --check          Write nothing; exit 1 if any file is outdated
  --dry-run        Write nothing; report what would change
  -h, --help       Show this help`;

export class UsageError extends Error {}

export interface RewriteArgs {
  projectDir: string;
  check: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): RewriteArgs | "help" {
  const args: RewriteArgs = { projectDir: "", check: false, dryRun: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--check") args.check = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new UsageError("Give the project folder to rewrite.");
  args.projectDir = positional[0];
  return args;
}

const SKIP = new Set(["node_modules", ".git", ".myco", "dist", "target"]);

/** Project-relative (forward-slash) paths of every scene and prefab file under `root`. */
export async function findSceneFiles(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) out.push(...(await findSceneFiles(root, rel)));
    } else if (isSceneOrPrefabPath(e.name)) out.push(rel);
  }
  return out;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: RewriteArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  let paths: string[];
  try {
    paths = await findSceneFiles(args.projectDir);
  } catch (e) {
    console.error(`Can't read "${args.projectDir}": ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const files = new Map<string, string>();
  for (const p of paths) files.set(p, await readFile(join(args.projectDir, p), "utf8"));
  const result = rewriteProjectFiles(files);

  const write = !args.check && !args.dryRun;
  for (const [path, text] of result.changed) {
    if (write) await writeFile(join(args.projectDir, path), text);
    console.log(`${write ? "rewrote" : "outdated"} ${path}`);
  }
  for (const { path, message } of result.errors) console.error(`error ${path}: ${message}`);
  const verb = write ? "rewritten" : "outdated";
  console.log(`${result.changed.size} ${verb}, ${result.unchanged.length} already latest, ${result.errors.length} errors.`);
  if (result.errors.length) return 1;
  return args.check && result.changed.size ? 1 : 0;
}
