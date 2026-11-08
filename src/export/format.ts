// The layout of a web build (ADR 0041): what the exporter writes and the player reads. Shared by
// the exporter (Node CLI and editor) and the player, so it imports nothing.
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

import type { BuiltPlugin } from "../plugins/thirdParty";

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
/** The list of the prebuilt player's files, in dist/player/ (not copied into builds). */
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
}

/** Where a compiled script, or a JSON file's module, goes in the build. */
export function modulePath(projectPath: string): string {
  return `${CODE_DIR}/${projectPath.endsWith(".ts") ? projectPath.slice(0, -3) : projectPath}.js`;
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
