// Record mode (ADR 0373): while it is on, changing an animatable field of a node under the bound Animator, in the
// Inspector or with a gizmo, writes a key at the playhead instead of changing the scene (Unity's record mode). This
// module decides what one field write becomes; the window's session (`animationSession.ts`) takes the write through
// the editor SDK's field write interceptor and groups a drag's writes into one undo step on the clip.
//
// - A field that is animatable is keyed whole (`position` → a `vec3` key).
// - A plain-object field with animatable sub-paths (D86: `spring.targetPosition`) keys each listed sub-path whose
//   value changed. A write that also changes parts no track can drive is left to the scene, so nothing is lost.
// - Anything else (a field no track can drive, a node outside the Animator) is left to the scene.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { fieldPathValue } from "../../../../engine/animation/bindingPath";
import { accept, type EditResult } from "../../../../editor/sdk";
import { keyField } from "./clipEditLogic";
import { animatableSubPaths, isAnimatablePath } from "./fieldTracksLogic";

/** One field write as record mode sees it. */
export interface RecordedWrite {
  /** The written node's path relative to the Animator's node ("" for that node), or null when it isn't under it. */
  readonly nodePath: string | null;
  readonly type: string;
  readonly field: string;
  /** The new value and what the scene holds now (scene-file JSON). */
  readonly value: unknown;
  readonly stored: unknown;
}

/** What a recorded write does: the clip edit and its undo label. */
export interface RecordedKey {
  readonly label: string;
  readonly result: EditResult<AnimSource>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every key of a plain object, as dotted leaf paths. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

/** Whether a leaf path lies inside (or is) one of `subs`. */
const within = (path: string, subs: readonly string[]) => subs.some((s) => path === s || path.startsWith(`${s}.`));

/**
 * What `write` becomes at time `t` in `clip`: a key (or keys) and its label, or null when record mode leaves it to the
 * scene. A key the clip refuses (the playhead outside the clip, a value that doesn't fit) comes back refused.
 */
export function recordWrite(clip: AnimSource, write: RecordedWrite, t: number): RecordedKey | null {
  if (write.nodePath === null) return null;
  const binding = { nodePath: write.nodePath, component: write.type, field: write.field };
  if (isAnimatablePath(write.type, write.field)) return { label: `Record ${write.field}`, result: keyField(clip, binding, write.value, t) };
  const subs = animatableSubPaths(write.type, write.field);
  if (!subs.length) return null;
  /** The value at sub-path `p` of the written field in `v` (the field's value). */
  const at = (v: unknown, p: string) => fieldPathValue(v, `${write.field}.${p}`);
  const changed = [...new Set([...leafPaths(write.value), ...leafPaths(write.stored)])].filter((p) => !same(at(write.value, p), at(write.stored, p)));
  const keyed = subs.filter((s) => !same(at(write.value, s), at(write.stored, s)));
  if (!keyed.length || changed.some((p) => !within(p, subs))) return null;
  let result: EditResult<AnimSource> = accept(clip);
  for (const s of keyed) {
    if ("refused" in result) break;
    result = keyField(result.next, { ...binding, field: `${write.field}.${s}` }, at(write.value, s), t);
  }
  return { label: `Record ${keyed.map((s) => `${write.field}.${s}`).join(", ")}`, result };
}
