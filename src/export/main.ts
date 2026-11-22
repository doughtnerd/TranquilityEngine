/**
 * `npm run export`: build a project into a game (ADR 0041).
 *
 * ```sh
 * npm run export -- <projectDir> [--out <dir>] [--target web|desktop] [--platform web|desktop|android]
 *                   [--no-audio-convert] [--scene <path>] [--audio-capture]
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
import { parseCommandLine, readCommandLine, UsageError, type Command } from "../server/commandLine";
import { ExportError, ServerError, exportProject, type ExportOptions, type ExportTarget } from "./node";

export const USAGE = `Usage: npm run export -- <projectDir> [options]

Builds a project into a game you can host or install.

Options:
  --out DIR        Output folder (default: <projectDir>/dist/<target>)
  --target T       web (default): a static web build; desktop: a Tauri app of it
  --platform P     The platform images and audio are converted for: web, desktop or android (default: the
                   target's). Audio follows audio.json's encoding profiles and packages; the build's
                   audio-report.json lists every sound's size, memory and where each setting came from
  --no-audio-convert
                   Ship audio as its sources (packages are still built); for debugging
  --scene PATH     The scene to start in (default: scenes/main.scene.json, else the first scene)
  --audio-capture  Ship the audio capture trigger: F9 (or a one-second three-finger hold) records the game's audio mix and
                   saves a .mycap file for the editor's Profiler. The file names the project's clips, buses and events.
  --audio-take     Ship the audio take trigger: F10 records a take (what the game asked of audio, and the profile) and
                   saves a .mycotake file for the Studio. The file names the project's playlists, parameters and nodes.
  --no-take-pictures
                   With --audio-take: takes record no pictures of the game view (by default a small JPEG about
                   once a second, which the Studio shows beside the take)
  --build          Desktop: run tauri build (default when Rust is installed)
  --no-build       Desktop: only write the Tauri project
  -h, --help       Show this help`;

const EXPORT_COMMAND: Command<ExportOptions> = {
  argument: "project folder",
  verb: "export",
  options: {
    "--out": { takes: "a folder", set: (o, v) => void (o.out = v) },
    "--target": {
      takes: "web or desktop",
      set: (o, v) => {
        if (v !== "web" && v !== "desktop") throw new UsageError(`--target is web or desktop (got ${JSON.stringify(v)}).`);
        o.target = v as ExportTarget;
      },
    },
    "--platform": {
      takes: "web, desktop or android",
      set: (o, v) => {
        if (v !== "web" && v !== "desktop" && v !== "android") throw new UsageError(`--platform is web, desktop or android (got ${JSON.stringify(v)}).`);
        o.platform = v;
      },
    },
    "--no-audio-convert": { set: (o) => void (o.audioConvert = false) },
    "--scene": { takes: "a scene path", set: (o, v) => void (o.mainScene = v.replace(/\\/g, "/").replace(/^\.?\//, "")) },
    "--audio-capture": { set: (o) => void (o.audioCapture = true) },
    "--audio-take": { set: (o) => void (o.audioTake = true) },
    "--no-take-pictures": { set: (o) => void (o.audioTakeFrames = false) },
    "--build": { set: (o) => void (o.tauriBuild = true) },
    "--no-build": { set: (o) => void (o.tauriBuild = false) },
  },
};

/** `argv` (without node and the script) as export options, or `"help"`. Throws a `UsageError`. */
export function parseArgs(argv: readonly string[]): ExportOptions | "help" {
  const parsed = parseCommandLine(argv, EXPORT_COMMAND);
  if (parsed === "help") return parsed;
  if (parsed.options.tauriBuild !== undefined && parsed.options.target !== "desktop") throw new UsageError("--build and --no-build go with --target desktop.");
  if (parsed.options.audioTakeFrames === false && parsed.options.audioTake !== true) throw new UsageError("--no-take-pictures goes with --audio-take.");
  return { ...parsed.options, projectDir: parsed.argument };
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = readCommandLine("export", USAGE, () => parseArgs(argv));
  if (typeof options === "number") return options;
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
