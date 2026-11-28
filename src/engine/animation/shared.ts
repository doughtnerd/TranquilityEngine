/**
 * What the animation text formats share (ADR 0371, 0372): the parse result, reference helpers, the JSON writer and the
 * lenient reading, which is the Audio Studio formats' (`audio/lenientRead.ts`: a bad value falls back to its default
 * with one problem line, nothing throws, ADR 0306).
 *
 * **References.** A field that names another asset holds a reference string as written: `asset:clips/run.anim.json`,
 * `clips/run.anim.json`, or a sub-asset `asset:models/hero.glb#Anim/Run`. The editor's move rewrites every reference
 * string in a JSON file through its owner (ADR 0302, 0314 "JSON files stay with their owners"), so a format only has to
 * say which of its strings are references (each format's `…References`); `referencePath` turns one into the project
 * path it depends on.
 *
 * Pure; no plugin, no DOM. Internal to the engine and the animation plugin: not public API.
 */
import { isRecord, LenientReader, type JsonRecord } from "../audio/lenientRead";
import { normalizeAssetPath } from "../scene/assetPath";

export { IdScope, isFiniteNumber, isRecord, LenientReader, type JsonRecord } from "../audio/lenientRead";

/** @internal A format's parse: the canonical value and its problem lines (prefixed with the file's path when given). */
export interface FormatParse<T> {
  readonly value: T;
  readonly problems: string[];
}

/** @internal The project path a reference string names: without `asset:`, a leading `./` or `/`, or a `#sub-asset`. Empty for none. */
export function referencePath(ref: string): string {
  const path = normalizeAssetPath(ref);
  const hash = path.indexOf("#");
  return hash < 0 ? path : path.slice(0, hash);
}

/** @internal The project paths of `refs` (empty ones skipped), once each, in order. */
export function referencePaths(refs: readonly (string | null | undefined)[]): string[] {
  return [...new Set(refs.filter((r): r is string => typeof r === "string" && r !== "").map(referencePath).filter((p) => p !== ""))];
}

/** @internal A value as file text: two-space JSON and a final newline (every Myco JSON asset's layout). */
export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * @internal Checks the `format` member and the root object; returns the root to read (an empty object when it isn't one).
 * A wrong or missing `format` is a problem, but the rest is read anyway (as every engine format does).
 */
export function readRoot(raw: unknown, format: string, what: string, problems: string[]): JsonRecord {
  if (!isRecord(raw)) {
    problems.push(`${what} must be a JSON object; using an empty one.`);
    return {};
  }
  if (raw.format !== format) problems.push(`format: expected "${format}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  return raw;
}

/** @internal `problems` prefixed with `path` when given. */
export const withPath = (problems: string[], path?: string): string[] => (path ? problems.map((p) => `${path}: ${p}`) : problems);

/** @internal A list of at most `limit` items: the rest are dropped with one problem. */
export function limited(r: LenientReader, raw: unknown, where: string, limit: number, what: string): unknown[] {
  const list = r.list(raw, where);
  if (list.length <= limit) return list;
  r.problem(where, `at most ${limit} ${what}; the rest are dropped.`);
  return list.slice(0, limit);
}

/** @internal A reference string, or null (absent, null or empty); a non-string is dropped with a problem. */
export function readRef(r: LenientReader, raw: unknown, where: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    r.problem(where, "must be an asset reference string; dropped.");
    return null;
  }
  return raw;
}

/** @internal A JSON value kept as written (event args, audio params, control payloads); undefined stays absent. */
export function readJsonValue(raw: unknown): unknown {
  return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
}

/** @internal A string's UTF-8 byte length. */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** @internal `out` without its undefined members (writers set a member to undefined to leave a default out). */
export function compact(out: JsonRecord): JsonRecord {
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
