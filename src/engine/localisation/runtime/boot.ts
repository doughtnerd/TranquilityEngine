/**
 * Starting `Locale` with a project (ADR 0356 §6, §11): which strings an Engine's boot hands it and which language it
 * starts in. A build's player installs the build's string files first (`installBuildStrings`, from `game.json`'s
 * `localisation`); everything else (the editor's Play, the Studio, a game built on the engine library) reads the
 * project's string tables from the registered asset sources, and follows edits to them (`Assets.notifyChanged`).
 * Nothing here is public API.
 */
import type { ProjectSettings } from "../../core/settings";
import type { WorldKind } from "../../core/World";
import type { StorageBackend } from "../../platform/Storage";
import { Assets } from "../../scene/Assets";
import { stringsPathKind } from "../strings/format";
import { configureLocale, localeStrings, localeStringsChanged, LOCALE_STORAGE_KEY } from "../Locale";
import { readBuildLocalisation } from "./buildFile";
import { BuildStrings, ProjectStrings, type LocaleStrings } from "./strings";

let installed: BuildStrings | null = null;

/**
 * The player (ADR 0356 §11): use the build's string files, `game.json`'s `localisation` section, for every Engine from
 * now on. `urlOf` turns a build path into a URL. A build without the section keeps reading tables from its files.
 */
export function installBuildStrings(localisation: unknown, urlOf: (path: string) => string): void {
  const read = readBuildLocalisation(localisation);
  if (!read) return;
  installed = new BuildStrings(async (code) => {
    const path = Object.entries(read.strings).find(([c]) => c.toLowerCase() === code.toLowerCase())?.[1];
    if (path === undefined) return null;
    const res = await fetch(urlOf(path));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.json();
  }, read.pseudo);
}

/** Project strings read from the asset sources; the ones made here, so hot reload replaces only those. */
const fromAssets = new WeakSet<LocaleStrings>();
let listening = false;

function assetStrings(): ProjectStrings {
  const files = Assets.paths().filter((p) => stringsPathKind(p) !== null).map((p) => [p, Assets.get(p)] as const);
  const s = new ProjectStrings(files);
  fromAssets.add(s);
  if (!listening) {
    listening = true;
    Assets.onChanged((path) => {
      if (stringsPathKind(path) === null || !fromAssets.has(localeStrings())) return;
      localeStringsChanged(assetStrings());
    });
  }
  return s;
}

export interface LocaleBootOptions {
  /** The Engine's storage, for the remembered language. */
  readonly storage: StorageBackend;
  readonly kind: WorldKind;
  /** A game the player runs (not the editor's Play, which keeps its preview language): read and remember the player's choice. */
  readonly player: boolean;
  /** It draws (a game window): the system's languages count. */
  readonly draws: boolean;
}

/**
 * Configure `Locale` for an Engine's project (ADR 0356 §6): its languages and strings, and the start language, whose
 * strings and fonts load before this resolves. A dedicated server starts in the default language and remembers nothing.
 */
export async function bootLocale(settings: ProjectSettings, options: LocaleBootOptions): Promise<void> {
  const game = options.kind === "runtime" && options.player;
  let remembered: unknown;
  if (game && settings.languages.remember) {
    remembered = await Promise.resolve()
      .then(() => options.storage.load("settings", LOCALE_STORAGE_KEY))
      .catch(() => undefined);
  }
  const system = options.draws && options.kind === "runtime" && typeof navigator !== "undefined" ? [...(navigator.languages ?? [navigator.language])].filter(Boolean) : [];
  await configureLocale({ languages: settings.languages, strings: installed ?? assetStrings(), remembered, system, remember: game });
}
