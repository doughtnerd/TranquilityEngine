// Property tracks into the ECS each frame (ADR 0371; `animation.Apply`'s properties sub-step): for each Animator of the
// pass, the clip filling its column block this frame (D36: the highest-weight clip; none, and the fields keep their
// last values, as in Unity) is bound once (`bindings.ts`, cached per Animator and clip handle, rebuilt when the
// hierarchy it resolved against changes), then every bound column is written. An Animator the culling mode froze
// (`whenVisible`, `rootMotionOnly` while unseen) writes nothing, as its pose doesn't move (D34); its notifies still fire.
import type { AnimationFrame } from "../../stages/frame";
import { inPass } from "../../stages/gather/playback";
import { TRACK_COLUMNS } from "../../wasm/wire/core";
import { animatorsOf, type AnimatorRuntime } from "../instances";
import { bindClip, bindingsValid, type BindingTable } from "./bindings";
import { clipData, type ClipData } from "./clipData";
import { columnClip, trackRow, trackWords } from "./trackRegion";

const tables = new WeakMap<AnimatorRuntime, Map<number, BindingTable>>();
/** The clip tables each binding table was made from (a clip replaced in place, T70, binds again). */
const madeFrom = new WeakMap<BindingTable, unknown>();

/** @internal The asset reference of clip `handle` as the Animator holds it (for messages and `AnimationEvent.clip`). */
export function clipPathOf(rt: AnimatorRuntime, handle: number): string {
  for (const e of rt.clips.values()) if (e.handle === handle) return e.path;
  return `clip #${handle}`;
}

function tableFor(frame: AnimationFrame, rt: AnimatorRuntime, clip: number, data: ClipData): BindingTable {
  let byClip = tables.get(rt);
  if (!byClip) tables.set(rt, (byClip = new Map()));
  let t = byClip.get(clip);
  if (!t || !bindingsValid(frame.world, t) || madeFrom.get(t) !== data) {
    t = bindClip(frame.world, rt.animator.node, clipPathOf(rt, clip), data);
    madeFrom.set(t, data);
    byClip.set(clip, t);
  }
  return t;
}

/** @internal Writes each Animator's bound property columns (see the file header). */
export function scatterProperties(frame: AnimationFrame): void {
  const core = frame.core.core;
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt) || rt.frozen) continue;
    const row = trackRow(rt.instance);
    const clip = columnClip(trackWords(core), row);
    if (!clip) continue;
    const data = clipData(core, clip);
    if (data.columns.length === 0) continue; // no property tracks: nothing to bind or write (most skeletal clips)
    const table = tableFor(frame, rt, clip, data);
    const { f32, u32 } = trackWords(core); // binding may read the core (asset bytes): views again
    const at = (row + TRACK_COLUMNS) / 4;
    for (const e of table.entries) e.write(f32, u32, at + e.offset);
  }
}
