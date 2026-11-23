// The preview World's scene for the models a preview shows (ADR 0373, T18b): each model's node templates (what dropping it
// in a scene adds, through the editor SDK) built into one scene by `previewScene`, side by side when there are several.
// Loaded when the models change and again when the project's files do (a reimport changes the skeleton).
import { useEffect, useState } from "preact/hooks";
import { assetNodesFor, editor } from "../../../../editor/sdk";
import type { SceneFile } from "../../../../engine/scene/SceneLoader";
import { hasSkeleton, placementX, previewScene } from "./posedPreviewLogic";

/** A model to show: its root's name (what its clip is keyed by) and its path (null: not chosen yet). */
export interface PreviewModel {
  readonly role: string;
  readonly path: string | null;
}

/** What the models make: still loading, a scene to pose, or nothing to pose (a model without a skeleton, or none chosen). */
export type PosedScene = { readonly state: "loading" | "none"; readonly scene: null; readonly key: "" } | { readonly state: "posed"; readonly scene: SceneFile; readonly key: string };

let made = 0;

/** The scene for `models`, in order from left to right. */
export function usePosedScene(models: readonly PreviewModel[]): PosedScene {
  const wanted = models.map((m) => `${m.role}=${m.path ?? ""}`).join("|");
  const [state, setState] = useState<{ wanted: string; result: PosedScene }>({ wanted, result: { state: "loading", scene: null, key: "" } });
  const version = editor.project.version;
  useEffect(() => {
    let live = true;
    const none: PosedScene = { state: "none", scene: null, key: "" };
    if (models.length === 0 || models.some((m) => !m.path)) {
      setState({ wanted, result: none });
      return;
    }
    void Promise.all(models.map((m, i) => assetNodesFor(m.path!, [placementX(i, models.length), 0, 0]))).then((all) => {
      if (!live) return;
      if (all.some((templates) => !templates || !hasSkeleton(templates))) return setState({ wanted, result: none });
      const scene = previewScene(models.map((m, i) => ({ name: m.role, templates: all[i]! })));
      setState({ wanted, result: { state: "posed", scene, key: `${wanted}#${++made}` } });
    });
    return () => void (live = false);
  }, [wanted, version]);
  return state.wanted === wanted ? state.result : { state: "loading", scene: null, key: "" };
}
