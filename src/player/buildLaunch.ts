// What the player launches a build with (ADR 0447), read from `game.json` and the build's files, without a page:
// the manifest's format check, the files' JSON problems, the launch settings every host shares (`launchSettings`:
// project.json with audio.json's mix, and the legacy audio refusal), and the decisions the build's Export options
// leave to launch time: whether the debug link dials out or listens (ADR 0376, 0403), and whether the audio capture
// and take triggers are installed (ADR 0172, 0348). `main.ts` does the I/O and the imports these decisions call for;
// the rest of the typed manifest (scripts, plugins, audio media, string files, audio effects) it reads as it is.
import type { ProjectSettingsInput } from "../engine";
import { launchSettings } from "../engine/launchSettings";
import type { LoadedProjectFiles } from "../engine/scene/projectFiles";
import { MANIFEST_FORMAT, type GameManifest } from "../export/format";

/** What the page tells the player about where it runs (`main.ts` reads it from `location`, `navigator` and the shell). */
export interface PlayerEnvironment {
  /** The page's query string (`location.search`): a web build's `?debug-link=` and `?debug-code=`. */
  readonly search: string;
  /** A desktop shell's launch flags (`--debug-link`, `--debug-code`, which it sets as these globals). */
  readonly flags: { readonly __mycoDebugLink?: string; readonly __mycoDebugCode?: string };
  /** The page runs in a Tauri app (a desktop export, or one built from it for a phone). */
  readonly desktop: boolean;
  readonly userAgent: string;
}

/** How a build exported with debugging on starts its debug link (ADR 0376, 0403). */
export interface DebugLaunch {
  /** `game.json`'s `debug` section (`startDebugLink` and `startBuildListener` read it leniently). */
  readonly debug: NonNullable<GameManifest["debug"]>;
  /** An address given at launch, or null. */
  readonly override: string | null;
  /** A tool's pairing code given at launch, or null. */
  readonly code: string | null;
  /** What tools list the build as: a Tauri app on a phone says `android` (pairing plan D3). */
  readonly platform: "web" | "desktop" | "android";
  /** Connect out to a tool. A listen-only build doesn't also dial the default address unless given an address or a code. */
  readonly dial: boolean;
  /** Listen for tools (`debug.listen`): a native WebSocket on desktop, a rendezvous room on a page. */
  readonly listen: boolean;
}

/** What the player launches a build with. */
export interface BuildLaunch {
  /** The launch settings' project (`launchGame`'s `project`). */
  readonly project: ProjectSettingsInput;
  /** What audio.json says the runtime can't do, for the console. */
  readonly notices: readonly string[];
  /** Null: the build has no debugging, and nothing of the link is imported. */
  readonly debug: DebugLaunch | null;
  /** The Export option "audio capture" (ADR 0172): install the F9 / three-finger capture trigger. */
  readonly audioCapture: boolean;
  /** The Export option "audio takes" (ADR 0348): install the F10 take trigger, with or without pictures of the game view; null: off. */
  readonly audioTake: { readonly frames: boolean } | null;
}

/** `game.json`'s value, checked for the format this player reads. Throws an `Error` for the page when it isn't. */
export function checkManifest(raw: unknown): GameManifest {
  const format = typeof raw === "object" && raw !== null ? (raw as { format?: unknown }).format : undefined;
  if (format !== MANIFEST_FORMAT) throw new Error(`This player reads game.json format ${MANIFEST_FORMAT}, but the game is format ${String(format)}. Export it again.`);
  return raw as GameManifest;
}

/**
 * What the player launches `manifest` with, from the build's loaded files and where the page runs. Throws an `Error`
 * for the page when a JSON file doesn't parse or the launch settings refuse the project.
 */
export function buildLaunch(manifest: GameManifest, files: Pick<LoadedProjectFiles, "values" | "problems">, env: PlayerEnvironment): BuildLaunch {
  if (files.problems.length > 0) throw new Error(`Some of the game's JSON files don't parse: ${files.problems.map((p) => `${p.path} (${p.message})`).join(", ")}`);
  const settings = launchSettings(files.values);
  if (settings.refusal !== undefined) throw new Error(settings.refusal);
  return {
    project: settings.project,
    notices: settings.notices,
    debug: manifest.debug ? debugLaunch(manifest.debug, env) : null,
    audioCapture: manifest.audioCapture === true,
    audioTake: manifest.audioTake === true ? { frames: manifest.audioTakeFrames !== false } : null,
  };
}

function debugLaunch(debug: NonNullable<GameManifest["debug"]>, env: PlayerEnvironment): DebugLaunch {
  const query = new URLSearchParams(env.search);
  const override = query.get("debug-link") ?? env.flags.__mycoDebugLink ?? null;
  const code = query.get("debug-code") ?? env.flags.__mycoDebugCode ?? null;
  const platform = env.desktop ? (/Android/i.test(env.userAgent) ? "android" : "desktop") : "web";
  const listen = debug.listen === true;
  // A room code (ADR 0404) joins the tool's rendezvous room over WebRTC, so a code makes a listen-only build dial too.
  const dial = !listen || debug.link !== undefined || override !== null || code !== null;
  return { debug, override, code, platform, dial, listen };
}
