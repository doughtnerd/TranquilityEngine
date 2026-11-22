/**
 * Contract (ADR 0340 §2, §5; amended by 0343 §1, §4; extended by 0341 §4): the audio side of localisation.
 *
 * - `AudioLocalisation`: `audio.json`'s `localisation` section (localised roots, loudness for batch import, the duration
 *   check, what a line missing in every language does, the captions string table).
 * - `LineTable`: a line table, `*.lines.json` (`myco.lines@1`): keyed voice-over rows with speaker, notes, file names
 *   and the string key of their subtitle. Subtitle text lives in 0342's string tables (0343), not here.
 *
 * Pure; no plugin, no DOM.
 */

export const LINES_FORMAT = "myco.lines@1";
export const LINES_SUFFIX = ".lines.json";

/** `audio.json` `localisation`. */
export interface AudioLocalisation {
  /** Folders under which the first folder is a language code (`audio/vo` → `audio/vo/<code>/…`). */
  roots: string[];
  /** What batch import and "Normalise language" write into each file's sidecar `normalize` (0340 §8). */
  loudness: { mode: "off" | "loudness" | "peak"; target: number };
  /** A language's file is flagged when `|d − dRef| > max(0.5, durationTolerance × dRef)` seconds. */
  durationTolerance: number;
  /** A line no language of the chain has: subtitle-only for its reading time, or refused like a sample (0340 §3). */
  missing: "subtitleOnly" | "silent";
  /** The string table holding playlist captions (0343 §4), a Studio file. */
  captions: string;
}

/** One voice-over line. */
export interface LineRow {
  /** `[A-Za-z0-9_.-]{1,64}`, unique across the project. */
  key: string;
  speaker: string | null;
  /**
   * The string key of the subtitle (0343 §1): absent, the line key; null, never subtitled (breaths, efforts).
   */
  textKey?: string | null;
  /** Direction for actors; never shipped. */
  notes?: string;
  /** The file name stem under each language folder; null: the key. */
  file: string | null;
  /** Explicit per-language files (language code → project path), rare. */
  files: Record<string, string>;
  tags: string[];
  /** Seconds this line can't be said again by a dialogue event (0341 §4); 0: no cooldown. */
  cooldown: number;
  /** Said at most once a session by a dialogue event (0341 §4). */
  once: boolean;
  /**
   * 0340's retired per-language `text`, kept as read so nothing is lost until the Studio's "Move subtitles to the
   * string table" moves it (0343 §1); the runtime ignores it, and the parse lints it.
   */
  text?: Record<string, string>;
}

/** The line table file. */
export interface LineTable {
  format: typeof LINES_FORMAT;
  /** A localised root; null: the first of `localisation.roots`. */
  root: string | null;
  /** The folder under each language folder; "": the language folder itself. */
  folder: string;
  /** Bus; null: Voice when it exists, else Master. */
  output: string | null;
  /** A playlist with a programmer `line` entry every line plays through; null: a plain Clip. */
  template: string | null;
  /** 0..100, used by 0341's speaker channels. */
  priority: number;
  /** Names offered in the Speaker column (free text allowed). */
  speakers: string[];
  /** The string table holding this table's subtitles; null: `<stem>.strings.json` beside the table. */
  strings: string | null;
  lines: LineRow[];
}

export interface LineTableParse {
  table: LineTable;
  problems: string[];
}
