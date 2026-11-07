// Render texture assets in the editor (ADR 0109): creating `*.rendertexture.json` files, and
// reading and writing them for the Asset Inspector (ui/RenderTextureInspector.tsx).
import { defaultRenderTexture, formatRenderTexture, parseRenderTexture, type RenderTextureSettings } from "../engine/render/renderTexture";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

export interface ReadRenderTexture {
  settings: RenderTextureSettings;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: string[];
}

/** A render texture asset's settings as the file holds them now. */
export function readRenderTexture(project: EditorProject, path: string): ReadRenderTexture {
  try {
    return parseRenderTexture(project.assets.get(path), path);
  } catch (err) {
    return { settings: defaultRenderTexture(), problems: [(err as Error).message] };
  }
}

/** Write a render texture asset. Throws for a read-only project. */
export async function writeRenderTexture(project: EditorProject, path: string, settings: RenderTextureSettings): Promise<void> {
  await project.writeText(path, formatRenderTexture(settings));
}

/** Create `New Render Texture.rendertexture.json` (or `… 2`) in `folder`; its path, or null if it couldn't be. */
export async function createRenderTexture(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add render textures.` };
    return null;
  }
  const path = freePath(project, folder, "New Render Texture.rendertexture.json");
  try {
    await writeRenderTexture(project, path, defaultRenderTexture());
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
