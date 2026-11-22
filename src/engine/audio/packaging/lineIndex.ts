/**
 * Internal (ADR 0340 §6, amended by 0343 §1; L3): the built line index, `audio/lines/index.json`
 * (`myco.lines.index@1`), written by the export and read by the runtime in a build instead of the line tables. Per line
 * key: its table, speaker, priority, output, template, the dialogue fields (0341 §4), the string key of its subtitle when
 * it isn't the line key (or `null`: never subtitled), and per shipped language the file the language's chain resolves to
 * with its duration in seconds (`null`: no language of the chain has one). Subtitle text and notes never ship: subtitles
 * are in `strings/<code>.json` (0343).
 *
 * ```jsonc
 * { "format": "myco.lines.index@1", "languages": ["en", "fr"],
 *   "lines": { "intro_01": { "table": "audio/vo/ch1.lines.json", "speaker": "Ava", "priority": 50, "output": null,
 *     "template": null, "files": { "en": { "path": "audio/vo/en/ch1/intro_01.wav", "duration": 2.4 }, "fr": null } } } }
 * ```
 *
 * Parsed leniently (ADR 0306: never throws, one problem line per bad value). Pure; no plugin, no DOM.
 */
import { isLineKey } from "../localisation/lines/format";
import { isRecord, LenientReader, type JsonRecord } from "../lenientRead";

export const LINE_INDEX_FORMAT = "myco.lines.index@1";
/** Where the index goes in a build (relative to the build's root). */
export const LINE_INDEX_FILE = "audio/lines/index.json";

/** A line's file in one language: the path the chain resolved to, and its length in seconds (null when unknown). */
export interface LineIndexFile {
  path: string;
  duration: number | null;
}

/** One line of the index. */
export interface LineIndexEntry {
  /** The line table it comes from (a project path; the table itself doesn't ship). */
  table: string;
  speaker: string | null;
  priority: number;
  /** The bus it plays on; null: Voice when it exists, else Master. */
  output: string | null;
  /** The template playlist it plays through; null: a plain Clip. */
  template: string | null;
  /** The subtitle's string key when it isn't the line key; null: never subtitled. Absent: the line key. */
  textKey?: string | null;
  /** Dialogue fields (0341 §4), present when not at their defaults. */
  tags?: string[];
  cooldown?: number;
  once?: true;
  /** Per shipped language: its file, or null when no language of its chain has one. */
  files: Record<string, LineIndexFile | null>;
}

export interface LineIndex {
  format: typeof LINE_INDEX_FORMAT;
  /** The build's shipped languages, in order. */
  languages: string[];
  lines: Record<string, LineIndexEntry>;
}

/** An index with no lines. */
export const emptyLineIndex = (): LineIndex => ({ format: LINE_INDEX_FORMAT, languages: [], lines: {} });

/** The index as JSON (keys in a stable order, defaults left out). */
export function lineIndexToJson(index: LineIndex): JsonRecord {
  const lines: JsonRecord = {};
  for (const [key, e] of Object.entries(index.lines)) {
    lines[key] = {
      table: e.table, speaker: e.speaker, priority: e.priority, output: e.output, template: e.template,
      ...(e.textKey !== undefined ? { textKey: e.textKey } : {}),
      ...(e.tags && e.tags.length ? { tags: [...e.tags] } : {}),
      ...(e.cooldown ? { cooldown: e.cooldown } : {}),
      ...(e.once ? { once: true } : {}),
      files: Object.fromEntries(Object.entries(e.files).map(([c, f]) => [c, f ? { path: f.path, duration: f.duration } : null])),
    };
  }
  return { format: LINE_INDEX_FORMAT, languages: [...index.languages], lines };
}

/** The index's text: compact JSON (it ships) and a final newline. */
export const formatLineIndex = (index: LineIndex): string => `${JSON.stringify(lineIndexToJson(index))}\n`;

/** The index, leniently: bad lines and files dropped with a problem each. */
export function parseLineIndex(raw: unknown, where = LINE_INDEX_FILE): { index: LineIndex; problems: string[] } {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  const index = emptyLineIndex();
  const o = r.record(raw, where);
  if (!o) return { index, problems };
  if (o.format !== LINE_INDEX_FORMAT) r.problem(`${where}.format`, `expected "${LINE_INDEX_FORMAT}", found ${JSON.stringify(o.format)}; read as ${LINE_INDEX_FORMAT}.`);
  index.languages = r.list(o.languages, `${where}.languages`).filter((c): c is string => typeof c === "string");
  const lines = r.record(o.lines, `${where}.lines`) ?? {};
  for (const [key, v] of Object.entries(lines)) {
    const w = `${where}.lines.${key}`;
    if (!isLineKey(key)) { r.problem(w, "isn't a line key; dropped."); continue; }
    if (!isRecord(v)) { r.problem(w, "must be an object; dropped."); continue; }
    const entry: LineIndexEntry = {
      table: r.str(v.table, `${w}.table`, ""),
      speaker: r.strOrNull(v.speaker, `${w}.speaker`, null),
      priority: r.num(v.priority, `${w}.priority`, 50, 0, 100),
      output: r.strOrNull(v.output, `${w}.output`, null),
      template: r.strOrNull(v.template, `${w}.template`, null),
      files: {},
    };
    if (v.textKey !== undefined) entry.textKey = r.strOrNull(v.textKey, `${w}.textKey`, null);
    if (v.tags !== undefined) entry.tags = r.list(v.tags, `${w}.tags`).filter((t): t is string => typeof t === "string");
    if (v.cooldown !== undefined) entry.cooldown = r.num(v.cooldown, `${w}.cooldown`, 0, 0);
    if (v.once === true) entry.once = true;
    for (const [code, f] of Object.entries(r.record(v.files, `${w}.files`) ?? {})) {
      if (f === null) entry.files[code] = null;
      else if (isRecord(f) && typeof f.path === "string" && f.path !== "") {
        entry.files[code] = { path: f.path, duration: typeof f.duration === "number" && Number.isFinite(f.duration) && f.duration >= 0 ? f.duration : null };
      } else r.problem(`${w}.files.${code}`, "must be { path, duration } or null; dropped.");
    }
    index.lines[key] = entry;
  }
  return { index, problems };
}
