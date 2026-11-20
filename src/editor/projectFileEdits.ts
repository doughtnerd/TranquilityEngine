// One edit across the project's JSON files (ADR 0148, 0262): scenes and prefabs (one format, written keeping their
// layout, and instances of a changed prefab in the open scene rebuilt), project.json (the settings) and other JSON
// files (asset files such as materials and audio events). The open scene is edited as one undo step instead of on disk
// (save to keep it). The asset reference module (moves and deletes) and the settings names module (renamed list
// entries) describe their edits; this module finds the files and writes them.
import { ReplaceDocument, type SceneFile } from "./document";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
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
  /** Any other JSON file, by its project path. */
  json(json: unknown, path: string): unknown;
}

interface ChangedFile {
  readonly path: string;
  readonly scene: boolean;
  readonly next: unknown;
}

/** Each JSON file (other than `skip`, the open scene) `edit` changes, with its new value. Broken files are left alone. */
function changedFiles(project: EditorProject, edit: ProjectFileEdit, skip: string | undefined): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const path of project.files) {
    if (!path.endsWith(".json") || path === skip) continue;
    const text = project.textOf(path);
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
      if (next) out.push({ path, scene: true, next });
    } else {
      const next = path === "project.json" && json && typeof json === "object" && !Array.isArray(json) ? edit.settings(json as Record<string, unknown>) : edit.json(json, path);
      if (next !== null) out.push({ path, scene: false, next });
    }
  }
  return out;
}

/** The files `edit` would change, without changing them: the open scene first (when its document would change), then files on disk. */
export function projectFileUsers(project: EditorProject, edit: ProjectFileEdit): string[] {
  const scene = openScene.peek();
  const users = changedFiles(project, edit, scene?.path).map((f) => f.path);
  if (scene && edit.scene(scene.doc.toJSON())) users.unshift(scene.path);
  return users;
}

/**
 * Apply `edit` to the project's JSON files on disk and to the open scene as one undo step labelled `label`. Returns the
 * files changed (the open scene as "<path> (unsaved)").
 */
export async function editProjectFiles(project: EditorProject, edit: ProjectFileEdit, label: string): Promise<string[]> {
  const scene: OpenScene | null = openScene.peek();
  const changed: string[] = [];
  for (const file of changedFiles(project, edit, scene?.path)) {
    if (file.scene) {
      await writeSceneFile(project, file.path, file.next as SceneFile);
      // Instances of a changed prefab in the open scene show its new contents.
      if (scene) scene.sync.apply(instancesOf(scene.doc, file.path).map((node) => ({ kind: "rebuild", node }) as const));
    } else await project.writeText(file.path, `${JSON.stringify(file.next, null, 2)}\n`);
    changed.push(file.path);
  }
  if (scene) {
    const next = edit.scene(scene.doc.toJSON());
    if (next) {
      scene.stack.execute(new ReplaceDocument(next, label));
      changed.push(`${scene.path} (unsaved)`);
    }
  }
  return changed;
}
