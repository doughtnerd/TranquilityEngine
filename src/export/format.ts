// The layout of a web build (ADR 0041): what the exporter writes and the player reads. Shared by
// the exporter (Node CLI and editor) and the player, so it imports nothing but types.
//
//   index.html     the player page (player.html of the prebuilt player in dist/player/)
//   assets/        the player's bundle
//   myco.js        the engine as an ES module: the player and the compiled scripts both import it
//   game.json      the manifest (GameManifest)
//   project/       the project's files as they are (project.json, scenes, prefabs, images, audio…)
//   code/          the project's scripts compiled to JavaScript (scripts/Foo.ts → code/scripts/Foo.js),
//                  and a module per JSON file a script imports (data/x.json → code/data/x.json.js)
//   serve.mjs      a tiny static server (`node serve.mjs`), since browsers won't load modules from file://
//   README.txt     how to run it

import type { PluginEffectDecl } from "../engine/audio/effects/types";
import type { LoadMode } from "../engine/audio/encoding/types";
import type { PackCodec } from "../engine/audio/packaging/format";
import type { ImportPlatform } from "../engine/scene/importSettings";
import type { BuiltPlugin } from "../plugins/thirdParty";
import type { DebugManifest } from "../engine/debugLink/config";

/** The manifest's file name, at the build's root. */
export const MANIFEST_FILE = "game.json";
/** The folder the project's own files are copied into. */
export const PROJECT_DIR = "project";
/** The folder compiled scripts (and the JSON modules they import) go in. */
export const CODE_DIR = "code";
/** The engine module scripts import as `"myco"` (or `"tranquility"`), at the build's root. */
export const ENGINE_FILE = "myco.js";
/** The prebuilt player's page, written as the build's index.html. */
export const PLAYER_PAGE = "player.html";
/**
 * The list of the prebuilt player's files, in dist/player/ (not copied into builds): `{ files, debug? }`. `debug` names
 * the files of `files` that hold only the debug link (ADR 0376), which only builds with `game.json` `debug` get.
 */
export const PLAYER_FILE_LIST = "files.json";
/** The manifest format this exporter writes and the player reads. */
export const MANIFEST_FORMAT = 1;

/** `game.json`: everything the player needs besides the files themselves. */
export interface GameManifest {
  readonly format: number;
  /** The game's name (`project.json`'s `name`, else the folder's). */
  readonly name: string;
  /**
   * The scene every start-up World whose bootstrap config names no scenes loads (as the open
   * scene does in play mode); null if the project has none.
   */
  readonly mainScene: string | null;
  /** Project-relative paths of the files under `project/`, sorted. */
  readonly files: readonly string[];
  /** The compiled scripts, in load order: the source path, and the module's path in the build. */
  readonly scripts: readonly { readonly source: string; readonly module: string }[];
  /** Prefab and material files the scripts name in string literals, warmed up with every scene (ADR 0080); omitted when none. */
  readonly assetRefs?: readonly string[];
  /**
   * The enabled third-party plugins' runtime halves (ADR 0139), in dependency order: each manifest and
   * its compiled entry module, which the player activates after the first-party plugins. Omitted when none.
   */
  readonly plugins?: readonly BuiltPlugin[];
  /**
   * The Export option "audio capture" (ADR 0171 amended by 0172, X1): the player installs the built-in capture trigger
   * (F9, a one-second three-finger hold). Omitted when off, so a build without the option carries no trace of it.
   */
  readonly audioCapture?: true;
  /**
   * The Export option "audio takes" (ADR 0348): the player installs the take trigger (F10), so the game can record a take
   * (what it asked of audio and the engine's profile, `*.sporesample`). Omitted when off.
   */
  readonly audioTake?: true;
  /** ADR 0348: `false` keeps takes from recording pictures of the game view (a small JPEG about once a second). Omitted: they do. */
  readonly audioTakeFrames?: false;
  /**
   * ADR 0351 §7: the build's converted audio — its packages and the media table the clip resolver consults before
   * `Assets`. Omitted when nothing was converted or packaged (every sound ships loose, as before).
   */
  readonly audio?: AudioManifest;
  /**
   * ADR 0352 §8: the enabled plugins' audio effect modules, one entry per module, which the player registers before
   * `Engine.create` (so the first scene's chains find them). Omitted when no enabled plugin has an `audio` section.
   */
  readonly audioEffects?: readonly AudioEffectsEntry[];
  /**
   * ADR 0356 §11: the build's string files (`strings/<code>.json`, one per shipped language) and each language's fonts,
   * which the player loads with a language switch (`installBuildStrings`). Omitted when the project has neither a
   * `languages` section nor string tables.
   */
  readonly localisation?: LocalisationManifest;
  /**
   * ADR 0376: debugging on (`--debug-link`): the player starts the debug link, which connects to the tool at `link`. Only
   * such a build ships the link's code (the player's `debug` files). Omitted in a release export. A listen-only build
   * (ADR 0403: listening flags without `--debug-link`) has no `link`, so it doesn't dial the default address; the player
   * reads a missing link as the default (`readDebugManifest`) for anything that needs one.
   */
  readonly debug?: Omit<DebugManifest, "link"> & { readonly link?: string };
}

/** `game.json`'s `localisation` (ADR 0356 §11), as `readBuildLocalisation` reads it. */
export interface LocalisationManifest {
  /** Language code → its string file (relative to the build's root) and size. */
  readonly strings: Readonly<Record<string, { readonly url: string; readonly bytes: number }>>;
  /** Language code → its font files (relative to the build's root); languages without fonts are left out. */
  readonly fonts: Readonly<Record<string, readonly string[]>>;
  /** `--pseudo`: the pseudo-languages (`qps-ploc`, `qps-plocm`) may be chosen. Omitted otherwise. */
  readonly pseudo?: true;
}

/** One plugin audio module in a build (`game.json`'s `audioEffects`, ADR 0352 §8). */
export interface AudioEffectsEntry {
  readonly plugin: string;
  readonly title?: string;
  readonly version: string;
  /** The module's id in the plugin's `audio.modules`. */
  readonly module: string;
  /** The module file, relative to the build's root (`project/plugins/...`, or `code/deps/plugins/<name>/...` for an npm plugin). */
  readonly url: string;
  /** The module file's SHA-256, hex: the player refuses bytes that don't match. */
  readonly hash: string;
  readonly memoryMB: number;
  /** The effects the module holds, as the manifest's `audio` section was parsed (`parsePluginAudio`). */
  readonly effects: readonly PluginEffectDecl[];
}

/** `game.json`'s `audio` (ADR 0351 §7). */
export interface AudioManifest {
  /** The platform the build's audio was converted for. */
  readonly platform: ImportPlatform;
  /** The build's packages (`audio/packages/<name>.mycopak`), in `audio.json`'s order. */
  readonly packages: readonly AudioManifestPackage[];
  /** Converted or packaged sounds by project path (references in scenes, playlists and scripts stay project paths). */
  readonly media: Readonly<Record<string, AudioMediaEntry>>;
}

export interface AudioManifestPackage {
  readonly name: string;
  /** The package file (its base part when it has language parts), relative to the build's root. */
  readonly url: string;
  readonly bytes: number;
  /** Loaded at engine start, before the first scene. */
  readonly preload: boolean;
  /**
   * ADR 0354 §6: its language parts (`audio/packages/<name>.<code>.mycopak`), one per shipped language, when its contents
   * reach localised files. Omitted for a package without any.
   */
  readonly languages?: Readonly<Record<string, { readonly url: string; readonly bytes: number }>>;
}

/**
 * One sound in the media table: in a package (`package`), or a loose file. `url` (relative to the build's root) is a
 * packaged `stream` sound's loose media (`audio/stream/<hash>.<ext>`); a converted loose file has none: it keeps its own
 * project path, which `Assets` serves.
 */
export interface AudioMediaEntry {
  /** The first package holding it (in `audio.json`'s order). */
  readonly package?: string;
  /** Every package holding it, when there are several (A3): its bytes are in each, and loading any one makes it playable. */
  readonly packages?: readonly string[];
  /**
   * ADR 0354 §6: a localised file's language part, in its package(s): the first shipped language whose part holds it
   * (its own language, or one that falls back to it). Omitted for a sound in a base part or loose.
   */
  readonly language?: string;
  /** Every language part holding it, when there are several (`fr-CA`'s part may hold the `fr` file). */
  readonly languages?: readonly string[];
  readonly url?: string;
  readonly codec: PackCodec;
  readonly load: LoadMode;
  readonly rate: number;
  readonly channels: number;
  /** Frames per channel it decodes to. */
  readonly frames: number;
}

/**
 * Where a compiled script, or a JSON file's module, goes in the build. A Svelte rune module keeps its `.ts`
 * (`ui/hud.svelte.ts` → `code/ui/hud.svelte.ts.js`), so it never lands on a component beside it (`ui/hud.svelte`, ADR 0423).
 */
export function modulePath(projectPath: string): string {
  return `${CODE_DIR}/${projectPath.endsWith(".ts") && !projectPath.endsWith(".svelte.ts") ? projectPath.slice(0, -3) : projectPath}.js`;
}


/** A relative module specifier from build file `from` to build file `to` (both "/"-separated paths from the root). */
export function relativeSpecifier(from: string, to: string): string {
  const fromDirs = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let common = 0;
  while (common < fromDirs.length && common < toParts.length - 1 && fromDirs[common] === toParts[common]) common++;
  const up = fromDirs.length - common;
  const rest = toParts.slice(common).map(encodeURIComponent).join("/"); // a specifier is a URL: "#" or "?" in a name would cut it short
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}
