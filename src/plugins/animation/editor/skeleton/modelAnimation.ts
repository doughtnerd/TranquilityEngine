// What the two Import Settings cards read of the open model (ADR 0373; T54): its skeleton, takes, clips and bone map as
// the importer loaded them (`ModelData.animation`: the sidecar as saved, plus the core's guess when the sidecar has no
// `boneMap`), and skeleton profiles by reference. `useModelAnimation` loads the model when the card shows and again when
// the project's files change (an Apply rewrites the sidecar, which loads the model afresh).
import { useEffect, useState } from "preact/hooks";
import { loadModel, type ModelAnimation } from "../../../../engine/scene/models";
import { Assets, normalizeAssetPath } from "../../../../engine/scene/Assets";
import { parseSkeletonProfile, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { editor } from "../../../../editor/sdk";
import { humanoidProfile } from "./humanoidProfile";

/** A model's animation as the card reads it. */
export type ModelAnimationState =
  | { readonly state: "loading" }
  /** The model loaded and has no skeleton or takes (a static model). */
  | { readonly state: "none" }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "ready"; readonly animation: ModelAnimation };

/** The animation of the model at `path`, loaded once the card shows and again when the project's files change. */
export function useModelAnimation(path: string): ModelAnimationState {
  const [state, setState] = useState<ModelAnimationState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    loadModel(`asset:${path}`)
      .then((m) => live && setState(m.animation ? { state: "ready", animation: m.animation } : { state: "none" }))
      .catch((err: unknown) => live && setState({ state: "failed", error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [path, editor.project.version]);
  return state;
}

/** The skeleton profile `ref` names (null: the built-in Humanoid) as a value, or null when the file can't be read. Problems are the profile editor's to show. */
export function readProfile(ref: string | null): SkeletonProfile | null {
  if (ref === null || ref === "") return humanoidProfile();
  try {
    const path = normalizeAssetPath(ref);
    return Assets.has(path) ? parseSkeletonProfile(Assets.json(path), path).value : null;
  } catch {
    return null;
  }
}

/** The project's models (the Assets panel's `model` kind) other than `path`, for a picker. */
export function otherModels(files: readonly string[], path: string): string[] {
  return files.filter((f) => f !== path && editor.assets.kindOf(f) === "model");
}
