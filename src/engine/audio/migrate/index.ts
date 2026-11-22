/**
 * Project-wide migration of audio events to playlists (ADR 0329 §"Migration"): every `*.audioevent.json` becomes a
 * `*.playlist.json` beside it with the same base name. Pure: it takes the project's text files and returns what to
 * write, what to delete (callers move the old file to `.myco/migrated/`) and the path moves, so callers rewrite the
 * references (scenes' `AudioSource.clip`, scripts, other assets) themselves; `project.ts` (`migrateProjectAudio`) does all
 * of that over a project folder. Never throws.
 */
import { formatPlaylist } from "../playlist/format";
import { AUDIO_EVENT_SUFFIX, isAudioEventPath, parseAudioEvent } from "../eventFormat";
import { PLAYLIST_SUFFIX, type PlaylistAsset } from "../playlist/types";
import { migrateAudioEvent, type MigrateOptions } from "./audioEvent1";

export { migrateAudioEvent, type MigrateOptions, type MigratedAudioEvent, type MigratedExtra } from "./audioEvent1";

export interface ProjectMigration {
  /** New files: path → JSON text. */
  writes: Map<string, string>;
  /** Old event files that were migrated. */
  deletes: string[];
  /** Path moves for reference rewriting. */
  references: { from: string; to: string }[];
  /** Lint lines: parse problems of the old files and the migration's approximations, each starting with a path. */
  notes: string[];
}

/** The playlist path that replaces an audio event path: same folder and base name. */
export const playlistPathFor = (eventPath: string): string => eventPath.slice(0, eventPath.length - AUDIO_EVENT_SUFFIX.length) + PLAYLIST_SUFFIX;

/** A playlist as file text (the playlist format's canonical writer). */
export function writePlaylistText(asset: PlaylistAsset): string {
  return formatPlaylist(asset);
}

/** Migrate every `*.audioevent.json` among `files` (project path → text). */
export function migrateProjectAudioEvents(files: ReadonlyMap<string, string>, options: MigrateOptions = {}): ProjectMigration {
  const out: ProjectMigration = { writes: new Map(), deletes: [], references: [], notes: [] };
  const paths = [...files.keys()].filter(isAudioEventPath).sort();
  for (const path of paths) {
    const to = playlistPathFor(path);
    if (files.has(to)) {
      out.notes.push(`${path}: ${to} already exists; not migrated.`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(files.get(path)!);
    } catch (e) {
      out.notes.push(`${path}: not valid JSON (${e instanceof Error ? e.message : String(e)}); not migrated.`);
      continue;
    }
    const { value, problems } = parseAudioEvent(raw);
    for (const p of problems) out.notes.push(`${path}: ${p}`);
    const migrated = migrateAudioEvent(value, path, options);
    out.writes.set(to, writePlaylistText(migrated.playlist));
    for (const x of migrated.extra) out.writes.set(x.path, JSON.stringify(x.asset, null, 2) + "\n");
    out.notes.push(...migrated.notes);
    out.deletes.push(path);
    out.references.push({ from: path, to });
  }
  return out;
}
