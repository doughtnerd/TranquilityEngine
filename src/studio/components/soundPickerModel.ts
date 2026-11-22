// The sound picker's list (ADR 0335 `SoundPicker`): the project's playlists and samples, searched by name and folder,
// in two sections (Playlists, then Samples), each sorted by path, and the keyboard's walk through the flat list of
// what is shown. The picker returns a project path; the owner wraps a sample in a Clip where it must (ADR 0329).
import type { BadgeCode } from "./typeBadgeModel";

/** One sound the picker can offer. */
export interface SoundItem {
  /** Project-relative path, what the picker returns. */
  readonly path: string;
  readonly kind: "playlist" | "sample";
  /** Its badge (a playlist's type; "SMP" for a sample). */
  readonly badge: BadgeCode;
  /** Shown instead of the file name, when given. */
  readonly name?: string;
  /** Can't be picked here, and why ("it would contain itself"). */
  readonly disabled?: string;
}

export interface SoundSection {
  readonly title: "Playlists" | "Samples";
  readonly items: readonly SoundItem[];
}

const SUFFIXES = [".playlist.json", ".wav", ".ogg", ".mp3", ".flac", ".m4a", ".aac", ".webm", ".opus"];

/** A sound's display name: `name`, else its file name without the playlist suffix or audio extension. */
export function soundName(item: SoundItem): string {
  if (item.name) return item.name;
  const file = item.path.slice(item.path.lastIndexOf("/") + 1);
  const lower = file.toLowerCase();
  const suffix = SUFFIXES.find((s) => lower.endsWith(s));
  return suffix ? file.slice(0, file.length - suffix.length) : file;
}

/** The folder a sound is in ("" at the project root). */
export const soundFolder = (item: SoundItem): string => (item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "");

/**
 * The sections to show for `query`: every word of it must appear in the sound's name or folder (case-insensitive).
 * Empty sections are left out. `only` keeps one kind (a Clip playlist picks samples only).
 */
export function soundSections(items: readonly SoundItem[], query: string, only?: SoundItem["kind"]): SoundSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (item: SoundItem) => {
    const hay = `${soundName(item)} ${item.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const byPath = (a: SoundItem, b: SoundItem) => a.path.localeCompare(b.path);
  const sections: SoundSection[] = [];
  for (const [title, kind] of [["Playlists", "playlist"], ["Samples", "sample"]] as const) {
    if (only && only !== kind) continue;
    const list = items.filter((i) => i.kind === kind && hit(i)).sort(byPath);
    if (list.length > 0) sections.push({ title, items: list });
  }
  return sections;
}

/** Every item shown, in order, for keyboard movement. */
export const flatItems = (sections: readonly SoundSection[]): SoundItem[] => sections.flatMap((s) => s.items);

/**
 * Where a key moves the active item (by path) in `shown`, or null for other keys: Down and Up step over disabled
 * items (stopping at the ends), Home and End go to the first and last pickable item. From nothing, Down picks the first.
 */
export function stepActive(shown: readonly SoundItem[], active: string | null, key: string): string | null {
  const enabled = shown.filter((i) => !i.disabled);
  if (enabled.length === 0) return null;
  const at = enabled.findIndex((i) => i.path === active);
  switch (key) {
    case "ArrowDown":
      return enabled[at < 0 ? 0 : Math.min(enabled.length - 1, at + 1)]!.path;
    case "ArrowUp":
      return enabled[at < 0 ? enabled.length - 1 : Math.max(0, at - 1)]!.path;
    case "Home":
      return enabled[0]!.path;
    case "End":
      return enabled[enabled.length - 1]!.path;
    default:
      return null;
  }
}
