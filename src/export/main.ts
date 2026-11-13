/**
 * `npm run export`: build a project into a game (ADR 0041).
 *
 * ```sh
 * npm run export -- <projectDir> [--out <dir>] [--target web|desktop] [--scene <path>] [--audio-capture]
 * ```
 *
 * - `--target web` (default) writes a static web build: the prebuilt player (dist/player/, built
 *   first if it's missing), the project's files, its scripts compiled to JavaScript, and game.json.
 *   It runs from any static host; `node serve.mjs` in the folder serves it locally.
 * - `--target desktop` writes that web build to `<out>/web/` and a Tauri project around it to
 *   `<out>/src-tauri/`, then runs `tauri build` if the Rust toolchain is installed (`--no-build`
 *   skips it; `--build` insists).
 *
 * Exits 0 when the build is written, 1 if the project can't be built (a script that doesn't
 * compile, a missing bootstrap script or scene, an output folder that isn't empty), 2 for bad
 * arguments. Node runs it from source through `cli.mjs` and the server's TypeScript hooks.
 */
import { ExportError, ServerError, exportProject, type ExportOptions, type ExportTarget } from "./node";

export const USAGE = `Usage: npm run export -- <projectDir> [options]

Builds a project into a game you can host or install.

Options:
  --out DIR        Output folder (default: <projectDir>/dist/<target>)
  --target T       web (default): a static web build; desktop: a Tauri app of it
  --scene PATH     The scene to start in (default: scenes/main.scene.json, else the first scene)
  --audio-capture  Ship the audio capture trigger: F9 (or a one-second three-finger hold) records the game's audio mix and
                   saves a .mycap file for the editor's Profiler. The file names the project's clips, buses and events.
  --build          Desktop: run tauri build (default when Rust is installed)
  --no-build       Desktop: only write the Tauri project
  -h, --help       Show this help`;

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ExportOptions | "help" {
  const options: Partial<ExportOptions> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("-")) throw new UsageError(`${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        return "help";
      case "--out":
        options.out = value();
        break;
      case "--target": {
        const t = value();
        if (t !== "web" && t !== "desktop") throw new UsageError(`--target is web or desktop (got ${JSON.stringify(t)}).`);
        options.target = t as ExportTarget;
        break;
      }
      case "--scene":
        options.mainScene = value().replace(/\\/g, "/").replace(/^\.?\//, "");
        break;
      case "--audio-capture":
        options.audioCapture = true;
        break;
      case "--build":
        options.tauriBuild = true;
        break;
      case "--no-build":
        options.tauriBuild = false;
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  }
  if (positional.length === 0) throw new UsageError("Give the project folder to export.");
  if (positional.length > 1) throw new UsageError(`Give one project folder (got ${positional.map((p) => JSON.stringify(p)).join(", ")}).`);
  if (options.tauriBuild !== undefined && options.target !== "desktop") throw new UsageError("--build and --no-build go with --target desktop.");
  return { ...options, projectDir: positional[0] };
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ExportOptions | "help";
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`export: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await exportProject({ ...options, log: (line) => console.log(line) });
    if (result.web === result.out) console.log(`Done. To play it here: node "${result.out.replace(/\\/g, "/")}/serve.mjs", then open the address it prints.`);
    return 0;
  } catch (err) {
    if (err instanceof ExportError || err instanceof ServerError) {
      console.error(`export: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
