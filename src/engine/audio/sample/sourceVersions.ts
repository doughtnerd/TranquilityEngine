/**
 * A sample's source versions (ADR 0342 "Source versions"): re-import copies the new file over the asset's path and
 * keeps every version's audio in `.myco/sample-versions/<path>/v<n>.<ext>` (per machine, like asset history). This is
 * the list of them, `versions.json` in that folder (`myco.sampleVersions@1`): which `v<n>` files are versions (the
 * folder also holds "Write to file" backups), their original names, when they came in, their length, and which one the
 * asset holds now.
 *
 * The sidecar's `sample.sourceVersion` says which version the edits were mapped to; the Studio keeps the asset's audio
 * on that version (an undo of "Re-import · v2" puts v1 back). No `sourceVersion` means the original (`v` of kind
 * `"original"`).
 *
 * The parse is lenient (nothing throws; bad entries are dropped). Pure; no plugin, no DOM.
 */
import { isFiniteNumber, isRecord } from "../lenientRead";

export const SOURCE_VERSIONS_FORMAT = "myco.sampleVersions@1";
/** The list's file name inside a sample's versions folder. */
export const SOURCE_VERSIONS_FILE = "versions.json";

/** Where a file's source versions are kept, relative to the project folder (per machine). */
export const sourceVersionsFolder = (path: string): string => `.myco/sample-versions/${path}`;

export interface SourceVersion {
  /** The version number (`v<n>`). */
  readonly n: number;
  /** The file in the versions folder (`v2.wav`). */
  readonly file: string;
  /** The audio before the first re-import, or one that came in by re-import. */
  readonly kind: "original" | "reimport";
  /** The name of the file it came from ("brake_skid_v2.wav"); the asset's own name for the original. */
  readonly name: string;
  /** When it came in (ISO 8601). */
  readonly at: string;
  /** Its length in seconds, when known. */
  readonly length: number | null;
}

export interface SourceVersions {
  /** The version the asset's file holds now. */
  readonly current: number;
  readonly versions: readonly SourceVersion[];
}

export const emptySourceVersions = (): SourceVersions => ({ current: 0, versions: [] });

/** `versions.json`, leniently (anything unreadable is the empty list). */
export function parseSourceVersions(raw: unknown): SourceVersions {
  if (!isRecord(raw) || !Array.isArray(raw.versions)) return emptySourceVersions();
  const versions: SourceVersion[] = [];
  for (const v of raw.versions) {
    if (!isRecord(v) || !Number.isInteger(v.n) || (v.n as number) < 1 || typeof v.file !== "string" || !/^v\d+\.[^/\\]+$/.test(v.file)) continue;
    if (versions.some((x) => x.n === v.n)) continue;
    versions.push({
      n: v.n as number,
      file: v.file,
      kind: v.kind === "original" ? "original" : "reimport",
      name: typeof v.name === "string" ? v.name : v.file,
      at: typeof v.at === "string" ? v.at : "",
      length: isFiniteNumber(v.length) && v.length >= 0 ? v.length : null,
    });
  }
  versions.sort((a, b) => a.n - b.n);
  const current = Number.isInteger(raw.current) && versions.some((v) => v.n === raw.current) ? (raw.current as number) : (versions[versions.length - 1]?.n ?? 0);
  return { current, versions };
}

/** `versions.json`'s content. */
export function sourceVersionsToJson(s: SourceVersions): Record<string, unknown> {
  return { format: SOURCE_VERSIONS_FORMAT, current: s.current, versions: s.versions.map((v) => ({ ...v })) };
}

/** The version `sourceVersion` names (absent: the original), or null when this machine doesn't have it. */
export function versionFor(s: SourceVersions, sourceVersion: number | undefined): SourceVersion | null {
  if (sourceVersion === undefined) return s.versions.find((v) => v.kind === "original") ?? null;
  return s.versions.find((v) => v.n === sourceVersion) ?? null;
}

/** The list with `v` added (replacing one of the same number) and made current when `current` is set. */
export function withVersion(s: SourceVersions, v: SourceVersion, current = true): SourceVersions {
  const versions = [...s.versions.filter((x) => x.n !== v.n), v].sort((a, b) => a.n - b.n);
  return { current: current ? v.n : s.current, versions };
}
