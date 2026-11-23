// The keyboard shortcuts dialog's list (ADR 0349): shortcuts in groups ("Everywhere", "Mixer", "Fader"), each with
// its keys written the platform's way, filtered by a search over what they do and their keys. Groups left empty by
// the search go.
import { formatKeys } from "./keyCombo";

export interface ShortcutEntry {
  /** What it does ("Switch to the Mixer"). */
  readonly label: string;
  /** Its key combos as text ("Mod+3"); the first is the main one. */
  readonly keys: readonly string[];
  /** Off now (single-key shortcuts turned off): listed, marked. */
  readonly off?: boolean;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
}

export interface ShownShortcut {
  readonly label: string;
  /** The keys as the platform writes them. */
  readonly keys: readonly string[];
  readonly off: boolean;
}

export interface ShownGroup {
  readonly title: string;
  readonly entries: readonly ShownShortcut[];
}

/** The groups as shown on this platform, filtered by `query` (blank: everything). */
export function shownShortcuts(groups: readonly ShortcutGroup[], query: string, mac: boolean): ShownGroup[] {
  const q = query.trim().toLowerCase();
  const out: ShownGroup[] = [];
  for (const g of groups) {
    const entries = g.entries
      .map((e) => ({ label: e.label, keys: e.keys.map((k) => formatKeys(k, mac)), off: !!e.off }))
      .filter((e) => q === "" || e.label.toLowerCase().includes(q) || g.title.toLowerCase().includes(q) || e.keys.some((k) => k.toLowerCase().includes(q)));
    if (entries.length > 0) out.push({ title: g.title, entries });
  }
  return out;
}
