/**
 * `UIPreferences` (ADR 0431): the player's UI preferences that CSS and Svelte read as user-preference media features,
 * the hook a game's options menu uses.
 *
 * - **`reducedMotion`**: canvas `@media (prefers-reduced-motion: reduce)` matches while it's true, and Svelte's
 *   `prefersReducedMotion` (`svelte/motion`) and `new MediaQuery("prefers-reduced-motion: reduce")` follow it.
 * - **`colorScheme`**: `"light"` or `"dark"`, for `@media (prefers-color-scheme: dark)` and its `MediaQuery`.
 * - **Values.** The player's own once set, else the system's: the browser's or desktop webview's media queries
 *   (`window.matchMedia`), followed live when they change; outside a browser, no reduced motion and light. Setting
 *   `null` follows the system's again.
 * - **Persisted** in player storage (ADR 0024, 0317), namespace `settings`, key `myco.ui`: a set saves at once, `reset`
 *   deletes the saved values. The UI plugin's World service loads them before a runtime World's first scene.
 *
 * Like `Graphics` and `Subtitles`, they belong to the player and the process, not to a World.
 */
import type { World } from "../core/World";
import { Storage } from "../platform/Storage";

/** The player storage key (namespace `settings`) the preferences persist under. */
export const UI_PREFERENCES_STORAGE_KEY = "myco.ui";

export type UIColorScheme = "light" | "dark";

/** What the player chose; a missing value follows the system. */
interface Chosen {
  reducedMotion?: boolean;
  colorScheme?: UIColorScheme;
}

let chosen: Chosen = {};
/** Counts sets and resets, so saved values that finish loading after one don't overwrite the player's change. */
let edits = 0;
let loadedFor: World | null = null;
let version = 0;
const listeners = new Set<() => void>();

type Query = { readonly matches: boolean; addEventListener?(type: "change", listener: () => void): void };
let system: { motion: Query | null; dark: Query | null } | null = null;

const NO_SYSTEM = { motion: null, dark: null };

/**
 * The system's media queries, asked once there's a `matchMedia` (a browser or desktop webview), and followed: a change
 * there notifies like a player's change.
 */
function systemQueries(): { motion: Query | null; dark: Query | null } {
  if (system) return system;
  const match = (globalThis as { matchMedia?: (q: string) => Query }).matchMedia;
  if (typeof match !== "function") return NO_SYSTEM;
  const ask = (q: string): Query | null => {
    try {
      const list = match.call(globalThis, q);
      list.addEventListener?.("change", () => {
        if (told !== null) after(told);
      });
      return list;
    } catch {
      return null;
    }
  };
  system = { motion: ask("(prefers-reduced-motion: reduce)"), dark: ask("(prefers-color-scheme: dark)") };
  told = effective();
  return system;
}

/** The values as last known (once the system's were asked), for a system change to compare with. */
let told: string | null = null;
const effective = (): string => `${UIPreferences.reducedMotion} ${UIPreferences.colorScheme}`;

/** Change what the player chose: when the values change, styles restyle and listeners hear it. */
function update(mutate: () => void): void {
  const before = effective();
  mutate();
  after(before);
}

function after(before: string): void {
  const now = effective();
  told = now;
  if (now === before) return;
  version++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error("[myco] a UIPreferences.onChange listener threw:", err);
    }
  }
}

function save(): void {
  edits++;
  const empty = chosen.reducedMotion === undefined && chosen.colorScheme === undefined;
  const done = empty ? Storage.delete(UI_PREFERENCES_STORAGE_KEY, "settings") : Storage.save(UI_PREFERENCES_STORAGE_KEY, { ...chosen }, "settings");
  done.catch((err: unknown) => console.warn("[myco] Couldn't save the UI preferences:", err));
}

/** A saved or given value read leniently: anything else follows the system. */
function read(data: unknown): Chosen {
  const out: Chosen = {};
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.reducedMotion === "boolean") out.reducedMotion = d.reducedMotion;
    if (d.colorScheme === "light" || d.colorScheme === "dark") out.colorScheme = d.colorScheme;
  }
  return out;
}

/** The player's UI preferences (ADR 0431): reduced motion and colour scheme, as CSS `@media` and Svelte read them. */
export const UIPreferences = {
  /** Whether the player prefers reduced motion: their choice, else the system's. Set `null` to follow the system again. */
  get reducedMotion(): boolean {
    return chosen.reducedMotion ?? systemQueries().motion?.matches ?? false;
  },
  set reducedMotion(value: boolean | null) {
    if (value !== null && typeof value !== "boolean") {
      console.warn(`[myco] UIPreferences.reducedMotion takes true, false or null (the system's), not ${String(value)}.`);
      return;
    }
    update(() => {
      if (value === null) delete chosen.reducedMotion;
      else chosen.reducedMotion = value;
    });
    save();
  },

  /** The colour scheme the player prefers: their choice, else the system's. Set `null` to follow the system again. */
  get colorScheme(): UIColorScheme {
    return chosen.colorScheme ?? (systemQueries().dark?.matches ? "dark" : "light");
  },
  set colorScheme(value: UIColorScheme | null) {
    if (value !== null && value !== "light" && value !== "dark") {
      console.warn(`[myco] UIPreferences.colorScheme takes "light", "dark" or null (the system's), not ${String(value)}.`);
      return;
    }
    update(() => {
      if (value === null) delete chosen.colorScheme;
      else chosen.colorScheme = value;
    });
    save();
  },

  /** Follow the system's preferences again; the saved values are deleted. */
  reset(): void {
    update(() => (chosen = {}));
    save();
  },

  /** Call `fn` after every change (the player's or the system's); returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** @internal Counts changes to the preferences, so styles matching `@media` on them restyle. */
export const uiPreferencesVersion = (): number => version;

/** @internal The UI plugin's World service: the saved preferences, read once before `world`'s first scene. */
export async function loadUIPreferences(world: World): Promise<void> {
  if (loadedFor === world) return;
  loadedFor = world;
  const editsBefore = edits;
  let saved: unknown;
  try {
    saved = await Storage.load(UI_PREFERENCES_STORAGE_KEY, "settings");
  } catch (err) {
    console.warn("[myco] Couldn't read the saved UI preferences:", err);
  }
  // The player changed something while this read was pending, or another World took over: keep what's there.
  if (edits !== editsBefore || loadedFor !== world) return;
  update(() => (chosen = read(saved)));
}

/** @internal The World that loaded the preferences ended: the next game in this process starts from its own storage. */
export function forgetUIPreferences(world: World): void {
  if (loadedFor !== world) return;
  loadedFor = null;
  update(() => (chosen = {}));
}
