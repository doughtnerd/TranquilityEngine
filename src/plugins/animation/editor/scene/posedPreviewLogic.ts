// The pure side of the posed asset previews (ADR 0373, T18b): how a model's node templates become the preview World's
// scene, and how a playhead maps to the normalised time a clip is played at. The previews pose models by playing the clip
// through the runtime at speed 0 (`posedPreview.ts`, the approach of the Animation window's preview, D129): no TypeScript
// evaluates a clip.
import type { NodeTemplate } from "../../../../editor/sdk";
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type ComponentEntry, type NodeEntry, type SceneFile } from "../../../../engine/scene/SceneLoader";

/** The part of a clip the playhead spans, in the clip's seconds (a split range of a longer clip). */
export interface PlayRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The normalised time (0–1 of the whole clip) to play a clip of `duration` seconds at, for a playhead `playhead` seconds
 * into what the preview shows: the whole clip, or `range` of it (a split range of a take: the playhead's zero is the
 * range's start, and its end is the range's end). Out-of-range playheads clamp to the shown part; an unusable duration
 * gives 0.
 */
export function normalizedTimeAt(playhead: number, duration: number, range?: PlayRange): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const from = range ? clamp(range.from, 0, duration) : 0;
  const to = range ? clamp(range.to, from, duration) : duration;
  const inside = clamp(Number.isFinite(playhead) ? playhead : 0, 0, to - from);
  return clamp((from + inside) / duration, 0, 1);
}

/** One model in a preview: the name of its root node (what the preview's clips are keyed by) and its node templates. */
export interface Placement {
  readonly name: string;
  readonly templates: readonly NodeTemplate[];
}

/** Whether the model's templates carry a skeleton to pose (a skinned model: `Skeleton` on the root). */
export function hasSkeleton(templates: readonly NodeTemplate[]): boolean {
  return templates[0]?.components?.some((c) => c.type === "engine.Skeleton") ?? false;
}

/** The root's Animator as the preview wants it: nothing plays by itself, and root motion stays in the pose (in place). */
function previewAnimator(c: ComponentEntry): ComponentEntry {
  const { defaultClip: _defaultClip, ...rest } = c.data ?? {};
  return { ...c, data: { ...rest, rootMotion: "none", cullingMode: "always" } };
}

/**
 * The scene file the preview World loads for `placements`: each model's templates as nodes (the first the root, named
 * `placement.name`; a descendant's parent is its template index, as the node insertion reads them), the root's Animator
 * stripped of its default clip and given none-mode root motion and no culling (a preview has no camera to see it), and a model's cameras left out (a preview has its own
 * view). A skinned model's root with no Animator gets one. Placements without a skeleton are drawn at rest.
 */
export function previewScene(placements: readonly Placement[]): SceneFile {
  const nodes: NodeEntry[] = [];
  placements.forEach((placement, p) => {
    const ids = placement.templates.map((_, i) => `p${p}n${i}`);
    placement.templates.forEach((t, i) => {
      const root = i === 0;
      let components = (t.components ?? []).filter((c) => c.type !== "engine.Camera");
      if (root) {
        components = components.map((c) => (c.type === "engine.Animator" ? previewAnimator(c) : c));
        if (hasSkeleton(placement.templates) && !components.some((c) => c.type === "engine.Animator")) components.push({ type: "engine.Animator", data: { rootMotion: "none", cullingMode: "always" } });
      }
      nodes.push({
        id: ids[i]!,
        name: root ? placement.name : (t.name ?? `Part ${i}`),
        ...(root || t.parent === undefined ? {} : { parent: ids[t.parent]! }),
        ...(t.active === false ? { active: false } : {}),
        components,
      });
    });
  });
  return { format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, nodes };
}

/** The x position of placement `index` of `count`, side by side and centred on the origin, `spacing` metres apart. */
export function placementX(index: number, count: number, spacing = 1.6): number {
  return (index - (count - 1) / 2) * spacing;
}
