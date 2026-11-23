/**
 * `Subtitles` (ADR 0343 §5): the player's subtitle settings, the hook a game's options menu uses, read by the built-in
 * `SubtitleDisplay` and by any replacement display, so one menu serves both.
 *
 * - **Values.** The player's own values once they changed something, else the project's first-run values
 *   (`project.json` `subtitles.defaults`, default on, medium, background 0.6, speaker names on, captions off).
 * - **Persisted** in player storage (ADR 0317), namespace `settings`, key `myco.subtitles`: `set` saves at once, `reset`
 *   deletes the saved values. The plugin's World service loads them before a runtime World's first scene.
 * - **Speakers.** `speaker(id)` is the lookup the built-in display uses: `project.json` `subtitles.speakers[id]`'s
 *   name string (`Locale.t`), else the id as written, and its colour.
 *
 * Built on public API only (`Storage`, `Locale`, the World's project settings).
 */
import { Color } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { Locale } from "../../../engine/localisation/Locale";
import { defaultSubtitleSettings, parseSubtitlePlayerSettings, type SubtitleSettings } from "../../../engine/localisation/subtitleSettings";
import { Storage } from "../../../engine/platform/Storage";

export type { SubtitleSettings, SubtitleSize } from "../../../engine/localisation/subtitleSettings";

/** The player storage key (namespace `settings`) the settings persist under. */
export const SUBTITLES_STORAGE_KEY = "myco.subtitles";

/** How a speaker shows: its name (the string `subtitles.speakers[id].name`, else the id) and colour (null: the display's). */
export interface SubtitleSpeakerLook {
  name: string;
  color: Color | null;
}

/** The player's values; null while they follow the project's defaults. */
let own: SubtitleSettings | null = null;
/** The World whose first scene loaded the saved values (its teardown forgets them, for the next game in the process). */
let loadedFor: World | null = null;
let frozen: { from: SubtitleSettings; value: Readonly<SubtitleSettings> } | null = null;
const listeners = new Set<(s: Readonly<SubtitleSettings>) => void>();

/** The project's first-run values (the active World's `project.json`), else the built-in ones. */
const projectDefaults = (): SubtitleSettings => World.active?.settings.subtitles?.defaults ?? defaultSubtitleSettings();

function current(): Readonly<SubtitleSettings> {
  const from = own ?? projectDefaults();
  if (frozen?.from !== from) frozen = { from, value: Object.freeze({ ...from }) };
  return frozen.value;
}

const same = (a: SubtitleSettings, b: SubtitleSettings): boolean => (Object.keys(a) as (keyof SubtitleSettings)[]).every((k) => a[k] === b[k]);

function notify(): void {
  const s = current();
  for (const fn of [...listeners]) {
    try {
      fn(s);
    } catch (err) {
      console.error("[myco] a Subtitles.onChange listener threw:", err);
    }
  }
}

const warn = (problems: readonly string[]): void => {
  for (const p of problems) console.warn(`[myco] ${p}`);
};

/** The player's subtitle settings (ADR 0343 §5). */
export const Subtitles = {
  /** The settings now: the player's, else the project's first-run values. */
  get settings(): Readonly<SubtitleSettings> {
    return current();
  },

  /** Change some settings: applies at once and persists. Bad values keep the current one, with a warning each. */
  set(patch: Partial<SubtitleSettings>): void {
    const problems: string[] = [];
    const before = current();
    const next = parseSubtitlePlayerSettings(patch, "Subtitles.set", problems, { ...before });
    warn(problems);
    if (own !== null && same(next, own)) return;
    own = next;
    Storage.save(SUBTITLES_STORAGE_KEY, { ...next }, "settings").catch((err: unknown) => console.warn("[myco] Couldn't save the subtitle settings:", err));
    if (!same(next, before)) notify();
  },

  /** Back to the project's first-run values; the saved values are deleted. */
  reset(): void {
    const before = current();
    own = null;
    Storage.delete(SUBTITLES_STORAGE_KEY, "settings").catch((err: unknown) => console.warn("[myco] Couldn't delete the saved subtitle settings:", err));
    if (!same(current(), before)) notify();
  },

  /** Call `fn` with the settings after every change; returns the unsubscribe. */
  onChange(fn: (s: Readonly<SubtitleSettings>) => void): () => void {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },

  /**
   * How speaker `id` (a line table row's `speaker`) shows: its `project.json` `subtitles.speakers` name string in the
   * current language (else the id as written) and its colour (null: the display's speaker colour).
   */
  speaker(id: string): SubtitleSpeakerLook {
    const def = World.active?.settings.subtitles?.speakers[id];
    const name = def?.name && Locale.has(def.name) ? Locale.t(def.name) : String(id);
    return { name, color: def?.color ? Color.from(def.color) : null };
  },
};

/** @internal The plugin's World service: the saved settings, read once before `world`'s first scene. */
export async function loadSubtitleSettings(world: World): Promise<void> {
  if (loadedFor === world) return;
  loadedFor = world;
  const before = current();
  let saved: unknown;
  try {
    saved = await Storage.load(SUBTITLES_STORAGE_KEY, "settings");
  } catch (err) {
    console.warn("[myco] Couldn't read the saved subtitle settings:", err);
  }
  if (saved === undefined || saved === null) own = null;
  else {
    const problems: string[] = [];
    own = parseSubtitlePlayerSettings(saved, `settings/${SUBTITLES_STORAGE_KEY}`, problems, projectDefaults());
    warn(problems);
  }
  if (!same(current(), before)) notify();
}

/** @internal The World that loaded the settings ended: the next game in this process starts from its own storage. */
export function forgetSubtitleSettings(world: World): void {
  if (loadedFor !== world) return;
  loadedFor = null;
  own = null;
}
