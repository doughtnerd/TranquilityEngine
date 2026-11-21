// One edit across the project's JSON files (ADR 0148, 0262, 0302), applied by each file's owner: scenes and prefabs
// by the scene format (written keeping their layout, and instances of a changed prefab in the open scene rebuilt; the
// open scene by its document, as one undo step, save to keep it), asset files of a kind with a format by their asset
// document (`assetFileOwner`: the open document, every state of its history, else the kind's format), project.json
// (the settings) and other JSON files as JSON. A file the Code panel holds unsaved text for has that buffer as a second
// owner (`codeBufferOwner`, ADR 0308): the file's own owner writes the disk, then the buffer takes the same change in
// its unsaved text, which stays unsaved; unsaved text that isn't valid JSON leaves the file alone, as a broken file is.
// The asset reference module (moves and deletes) and the settings names module (renamed list entries) describe their
// edits; this module finds the files and asks their owners.
import { assetFileOwner } from "./assetDocuments";
import { codeBufferOwner } from "./code/codeBuffers";
import { ReplaceDocument, type SceneFile } from "./document";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
import { PROJECT_FILE } from "./projectPaths";
import type { EditorProject } from "./projects";
import { openScene, type OpenScene } from "./state";

const isSceneFile = (json: unknown): json is SceneFile =>
  !!json && typeof json === "object" && typeof (json as { format?: unknown }).format === "string" && /^(myco|tranquility)\.scene@/.test((json as { format: string }).format) && Array.isArray((json as { nodes?: unknown }).nodes);

/** How one edit changes each kind of JSON file: the new value, or null for no change. */
export interface ProjectFileEdit {
  /** Only files whose text this accepts are parsed. */
  mentioned(text: string): boolean;
  scene(file: SceneFile): SceneFile | null;
  settings(json: Record<string, unknown>): Record<string, unknown> | null;
  /** Any other JSON file, by its project path. For an open asset document it is also called on each state of the document's history. */
  json(json: unknown, path: string): unknown;
}

interface FileChange {
  readonly path: string;
  /** Ask the file's owner to apply the edit; resolves to whether the file changed. */
  write(): Promise<boolean>;
}

const writeJson = (project: EditorProject, path: string, json: unknown) => project.writeText(path, `${JSON.stringify(json, null, 2)}\n`).then(() => true);

/** Each JSON file (other than the open scene's) `edit` changes, with how its owner applies it. Broken files are left alone. */
function fileChanges(project: EditorProject, edit: ProjectFileEdit, scene: OpenScene | null): FileChange[] {
  const out: FileChange[] = [];
  for (const path of project.files) {
    if (!path.endsWith(".json") || path === scene?.path) continue;
    const owner = path === PROJECT_FILE ? null : assetFileOwner(project, path);
    const text = owner ? owner.text : project.textOf(path);
    if (text === undefined || !edit.mentioned(text)) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (isSceneFile(json)) {
      // Scenes and prefabs share the format.
      const next = edit.scene(json);
      if (!next) continue;
      out.push({
        path,
        write: async () => {
          await writeSceneFile(project, path, next);
          // Instances of a changed prefab in the open scene show its new contents.
          if (scene) scene.sync.apply(instancesOf(scene.doc, path).map((node) => ({ kind: "rebuild", node }) as const));
          return true;
        },
      });
    } else if (path === PROJECT_FILE) {
      const next = json && typeof json === "object" && !Array.isArray(json) ? edit.settings(json as Record<string, unknown>) : null;
      if (next) out.push({ path, write: () => writeJson(project, path, next) });
    } else {
      const next = edit.json(json, path);
      if (next === null) continue;
      out.push({ path, write: owner ? () => owner.apply((value) => edit.json(value, path)) : () => writeJson(project, path, next) });
    }
  }
  return withCodeBuffers(project, edit, out);
}

/**
 * The changes with the Code panel's buffers as second owners (ADR 0308): a file the panel holds unsaved text for is
 * written by its own owner as before, then the buffer takes the same change (and a file only its unsaved text names
 * changes in the buffer alone). Unsaved text that isn't valid JSON leaves the file alone, on disk too.
 */
function withCodeBuffers(project: EditorProject, edit: ProjectFileEdit, changes: FileChange[]): FileChange[] {
  const out: FileChange[] = [];
  const byPath = new Map(changes.map((c) => [c.path, c]));
  for (const path of project.files) {
    const disk = byPath.get(path);
    const buffer = path.endsWith(".json") ? codeBufferOwner(project, path) : null;
    if (!buffer) {
      if (disk) out.push(disk);
      continue;
    }
    let unsaved: unknown;
    try {
      unsaved = JSON.parse(buffer.text);
    } catch {
      continue;
    }
    const change = (json: unknown): unknown =>
      isSceneFile(json) ? edit.scene(json) : path === PROJECT_FILE ? (isObject(json) ? edit.settings(json) : null) : edit.json(json, path);
    if (!disk && (!edit.mentioned(buffer.text) || change(unsaved) === null)) continue;
    out.push({
      path,
      write: async () => {
        const wrote = disk ? await disk.write() : false;
        return buffer.follow(change) || wrote;
      },
    });
  }
  return out;
}

const isObject = (json: unknown): json is Record<string, unknown> => !!json && typeof json === "object" && !Array.isArray(json);

/** The files `edit` would change, without changing them: the open scene first (when its document would change), then the others. */
export function projectFileUsers(project: EditorProject, edit: ProjectFileEdit): string[] {
  const scene = openScene.peek();
  const users = fileChanges(project, edit, scene).map((f) => f.path);
  if (scene && edit.scene(scene.doc.toJSON())) users.unshift(scene.path);
  return users;
}

/**
 * Apply `edit` to the project's JSON files through their owners, and to the open scene as one undo step labelled
 * `label`. Returns the files changed (the open scene as "<path> (unsaved)").
 */
export async function editProjectFiles(project: EditorProject, edit: ProjectFileEdit, label: string): Promise<string[]> {
  const scene: OpenScene | null = openScene.peek();
  const changed: string[] = [];
  for (const file of fileChanges(project, edit, scene)) if (await file.write()) changed.push(file.path);
  if (scene) {
    const next = edit.scene(scene.doc.toJSON());
    if (next) {
      scene.stack.execute(new ReplaceDocument(next, label));
      changed.push(`${scene.path} (unsaved)`);
    }
  }
  return changed;
}
