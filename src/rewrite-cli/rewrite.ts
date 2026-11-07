/**
 * Rewriting scene and prefab files to the latest format version (ADR 0013). Pure: files in as text,
 * files out as text, so it is testable without a disk.
 */
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, migrateSceneFile, type SceneFile } from "../engine/scene/SceneLoader";
import { formatSceneJSON, originalLayout } from "../editor/document/format";

export interface RewriteResult {
  /** Path → new text, for each file that was outdated and migrated. */
  changed: Map<string, string>;
  /** Scene and prefab files already in the latest format (left alone). */
  unchanged: string[];
  /** Files that didn't parse or migrate; they are neither changed nor unchanged. */
  errors: { path: string; message: string }[];
}

/** True for `*.scene.json` and `*.prefab.json` paths. */
export function isSceneOrPrefabPath(path: string): boolean {
  return /\.(scene|prefab)\.json$/i.test(path);
}

/**
 * Migrate every scene/prefab file in `files` (project-relative path → text; other paths are ignored)
 * to the current format version. A file already at the latest version is untouched. A migrated
 * file is written as the editor writes it (`formatSceneJSON`, keeping key order, the layout of
 * unchanged nodes and CRLF line endings).
 */
export function rewriteProjectFiles(files: ReadonlyMap<string, string>): RewriteResult {
  const result: RewriteResult = { changed: new Map(), unchanged: [], errors: [] };
  const latest = `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`;
  for (const [path, text] of [...files].filter(([p]) => isSceneOrPrefabPath(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      const file = JSON.parse(text.replace(/^﻿/, "")) as SceneFile;
      if (file?.format === latest) {
        result.unchanged.push(path);
        continue;
      }
      const migrated = migrateSceneFile(file, path);
      const lf = text.replace(/\r\n/g, "\n");
      const out = formatSceneJSON(migrated, originalLayout(lf));
      result.changed.set(path, text.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out);
    } catch (e) {
      result.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
