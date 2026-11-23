/**
 * The line registry (ADR 0354 §5–§6, 0355 §1): every line key and dialogue event name of the project, from the line
 * index (`audio/lines/index.json`, `lineIndex.ts`) and the line tables and dialogue files it names, read through the
 * asset sources. Keys and names are unique across the project: the first table (or file) in path order wins and the
 * rest are warned once. Rebuilt when the index or any file it names changes (a new object from the asset source after
 * an edit or a hot reload).
 */
import { Assets } from "../../../../engine/scene/Assets";
import { LINE_INDEX_PATH, lineIndexOf, lineIndexToJson, parseLineIndex } from "../../../../engine/audio/localisation/lines/lineIndex";
import { onAudioSessionReleased } from "../audioSession";
import { parseLineTable } from "../../../../engine/audio/localisation/lines/format";
import { lineKeyIndex, type LineLocation } from "../../../../engine/audio/localisation/lines/resolve";
import { parseDialogue } from "../../../../engine/audio/dialogue/format";
import type { DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { warnOnce } from "../core/handle";

/** Where a dialogue event is defined. */
export interface EventLocation {
  path: string;
  event: DialogueEvent;
}

interface Registry {
  /** The raw values it was built from, in read order (the index first). */
  readonly reads: readonly unknown[];
  readonly lines: ReadonlyMap<string, LineLocation>;
  readonly events: ReadonlyMap<string, EventLocation>;
}

let built: Registry | null = null;

/** A project JSON file's value; undefined when there is none. */
export function readJson(path: string): unknown {
  try {
    return Assets.has(path) ? Assets.get(path) : undefined;
  } catch {
    return undefined;
  }
}

function build(index: unknown): Registry {
  const reads: unknown[] = [index];
  const lines = new Map<string, LineLocation>();
  const events = new Map<string, EventLocation>();
  if (index === undefined) return { reads, lines, events };
  const parsed = parseLineIndex(index);
  for (const p of parsed.problems) warnOnce(`lineIndex:${p}`, p);
  const tables: { path: string; table: ReturnType<typeof parseLineTable>["table"] }[] = [];
  for (const path of parsed.index.tables) {
    const raw = readJson(path);
    reads.push(raw);
    if (raw === undefined) { warnOnce(`lineTable:missing:${path}`, `the line index names "${path}", which isn't in the project; its lines can't play.`); continue; }
    const t = parseLineTable(raw, path);
    for (const p of t.problems) warnOnce(`lineTable:${path}:${p}`, p);
    tables.push({ path, table: t.table });
  }
  const keys = lineKeyIndex(tables);
  for (const d of keys.duplicates) warnOnce(`lineKey:dup:${d.key}`, `the line key "${d.key}" is defined in ${d.paths.join(", ")}; "${d.paths[0]}"'s plays.`);
  for (const [k, v] of keys.keys) lines.set(k, v);
  for (const path of parsed.index.dialogue) {
    const raw = readJson(path);
    reads.push(raw);
    if (raw === undefined) { warnOnce(`dialogue:missing:${path}`, `the line index names "${path}", which isn't in the project; its dialogue events can't be said.`); continue; }
    const d = parseDialogue(raw, path);
    for (const p of d.problems) warnOnce(`dialogue:${path}:${p}`, p);
    for (const event of d.dialogue.events) {
      const first = events.get(event.name);
      if (first) { warnOnce(`dialogueEvent:dup:${event.name}`, `the dialogue event "${event.name}" is defined in ${first.path} and ${path}; "${first.path}"'s is said.`); continue; }
      events.set(event.name, { path, event });
    }
  }
  return { reads, lines, events };
}

/**
 * Without an index file (the editor's Play, the Studio), the index of what the asset sources list (`Assets.paths`):
 * listed again after an asset change, a session release, or at most every quarter second.
 */
let listed: { at: number; raw: unknown } | null = null;
const LIST_EVERY_MS = 250;
Assets.onChanged(() => { listed = null; });
onAudioSessionReleased(() => { listed = null; built = null; });

function listedIndex(): unknown {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (listed && now - listed.at < LIST_EVERY_MS) return listed.raw;
  const index = lineIndexOf(Assets.paths());
  const raw = index.tables.length === 0 && index.dialogue.length === 0 ? undefined : lineIndexToJson(index);
  // Keep the same object while the listing is the same, so the registry isn't rebuilt.
  const same = listed && JSON.stringify(listed.raw) === JSON.stringify(raw);
  listed = { at: now, raw: same ? listed!.raw : raw };
  return listed.raw;
}

function registry(): Registry {
  const index = readJson(LINE_INDEX_PATH) ?? listedIndex();
  const r = built;
  if (r && r.reads[0] === index) {
    // The files it names, in the order they were read (the index names them in that order).
    let same = true;
    if (index !== undefined) {
      const parsed = parseLineIndexCached(index);
      const paths = [...parsed.tables, ...parsed.dialogue];
      same = paths.length === r.reads.length - 1 && paths.every((p, i) => readJson(p) === r.reads[i + 1]);
    }
    if (same) return r;
  }
  return (built = build(index));
}

let indexCache: { raw: unknown; tables: string[]; dialogue: string[] } | null = null;
function parseLineIndexCached(raw: unknown): { tables: string[]; dialogue: string[] } {
  if (indexCache === null || indexCache.raw !== raw) indexCache = { raw, ...parseLineIndex(raw).index };
  return indexCache;
}

/** The line `key` and its table; null when no table defines it. */
export function lineLocation(key: string): LineLocation | null {
  return registry().lines.get(key) ?? null;
}

/** The dialogue event `name`; null when no dialogue file defines it. */
export function dialogueEvent(name: string): EventLocation | null {
  return registry().events.get(name) ?? null;
}
