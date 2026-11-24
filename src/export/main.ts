/**
 * `npm run export`: build a project into a game (ADR 0041).
 *
 * ```sh
 * npm run export -- <projectDir> [--out <dir>] [--target web|desktop] [--platform web|desktop|android]
 *                   [--no-audio-convert] [--scene <path>] [--audio-capture] [--languages <codes>] [--pseudo]
 *                   [--debug-link <address>] [--debug-listen] [--debug-lan] [--debug-port N] [--debug-rendezvous <url>]
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
import { debugLinkAddress } from "../engine/debugLink/config";

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
  --languages L    Ship only these languages, comma-separated (default: every language project.json ships;
                   ship: false ones are always left out). Each gets its strings/<code>.json, its fonts, its
                   localised files and its part of each audio package
  --pseudo         Add the pseudo-languages (qps-ploc, qps-plocm), for testing text expansion and right-to-left
  --audio-capture  Ship the audio capture trigger: F9 (or a one-second three-finger hold) records the game's audio mix and
                   saves a .sporesample file for the editor's Profiler. The file names the project's clips, buses and events.
  --audio-take     Ship the audio take trigger: F10 records a take (what the game asked of audio, and the profile) and
                   saves a .sporesample file for the Studio. The file names the project's playlists, parameters and nodes.
  --no-take-pictures
                   With --audio-take: takes record no pictures of the game view (by default a small JPEG about
                   once a second, which the Studio shows beside the take)
  --debug-link A   Debugging on: the game connects to the editor's debug link at A (ws://host:port, host:port, or
                   a port on this machine, such as 7790) so its live debuggers can inspect it. A desktop app also
                   takes --debug-link <address> when launched. Builds without it hold none of the link's code
  --debug-listen   Debugging on, and the game listens for tools (game.json debug.listen) as well as connecting out. A
                   desktop app gets the native listener, built into it by tauri build; a web build can't listen, so
                   there the key is harmless. A desktop app also takes --debug-code <code> when launched
  --debug-lan      Debugging on; a listening game accepts tools from other machines on its network (debug.lan: binds
                   0.0.0.0, each tool paired by code) instead of this machine only. Off by default
  --debug-port N   Debugging on; the first port a listening game tries (debug.port, default 7790; it tries the next nine)
  --debug-rendezvous U
                   Debugging on; the hosted rendezvous (a ws:// or wss:// URL, game.json debug.rendezvous) a room code
                   without a LAN rendezvous uses. A debug web build's serve.mjs also hosts a rendezvous itself
                   (rendezvous.mjs beside it, built with npm run build:rendezvous if missing); with --debug-lan it
                   serves the local network (0.0.0.0) and prints the addresses to open
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
    "--languages": {
      takes: "language codes",
      set: (o, v) => {
        const codes = v.split(",").map((c) => c.trim()).filter(Boolean);
        if (codes.length === 0) throw new UsageError(`--languages needs language codes such as en,fr (got ${JSON.stringify(v)}).`);
        o.languages = codes;
      },
    },
    "--pseudo": { set: (o) => void (o.pseudo = true) },
    "--audio-capture": { set: (o) => void (o.audioCapture = true) },
    "--audio-take": { set: (o) => void (o.audioTake = true) },
    "--no-take-pictures": { set: (o) => void (o.audioTakeFrames = false) },
    "--debug-link": {
      takes: "the editor's address",
      set: (o, v) => {
        if (!debugLinkAddress(v)) throw new UsageError(`--debug-link is a WebSocket address: ws://host:port, host:port or a port (got ${JSON.stringify(v)}).`);
        o.debugLink = v;
      },
    },
    "--debug-listen": { set: (o) => void (o.debugListen = true) },
    "--debug-lan": { set: (o) => void (o.debugLan = true) },
    "--debug-port": {
      takes: "a port",
      set: (o, v) => {
        const port = /^\d+$/.test(v) ? Number(v) : NaN;
        if (!(port >= 1 && port <= 65526)) throw new UsageError(`--debug-port is a whole number from 1 to 65526 (got ${JSON.stringify(v)}).`);
        o.debugPort = port;
      },
    },
    "--debug-rendezvous": {
      takes: "a ws:// or wss:// URL",
      set: (o, v) => {
        let protocol = "";
        try {
          protocol = new URL(v.trim()).protocol;
        } catch {
          // not a URL: refused below
        }
        if (protocol !== "ws:" && protocol !== "wss:") throw new UsageError(`--debug-rendezvous is a ws:// or wss:// URL (got ${JSON.stringify(v)}).`);
        o.debugRendezvous = v;
      },
    },
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
