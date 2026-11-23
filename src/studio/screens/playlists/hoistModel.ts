// "Move to playlist" (spec 2.8, the prototype's hoist hint, W11.4): when every entry of a playlist is a clip with the
// same effect (type and parameters), that effect can run once on the playlist's mix instead of on each clip: it is
// taken off every clip and added to the playlist's chain, as one undo step. Pure.
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../engine/audio/effects/types";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../editor/sdk/editResult";
import { nextEffectId } from "../../components/effectChainModel";

const sameEffect = (a: Effect, b: Effect) => a.type === b.type && a.on === b.on && JSON.stringify(a.params) === JSON.stringify(b.params);

/** The effects every entry's clip has (at least two clips, all embedded Clips), the first clip's copies; empty when none. */
export function sharedClipEffects(body: PlaylistBody): Effect[] {
  if (body.type === "clip" || body.type === "sequence" || body.entries.length < 2) return [];
  const clips = body.entries.map((e) => (e.kind === "embedded" && e.embedded.type === "clip" ? e.embedded : null));
  if (clips.some((c) => c === null)) return [];
  return clips[0]!.effects.filter((f) => clips.every((c) => c!.effects.some((g) => sameEffect(f, g))));
}

/** The hint's words: "Every clip has Distortion." */
export const hoistText = (e: Effect): string => `Every clip has ${effectSpec(e.type).label}. Moving it here runs it once on the mix instead of on each voice.`;

/** Take `effect` (one every clip has) off each clip and add it to the playlist's chain. */
export function hoistEffect(body: PlaylistBody, effect: Effect): EditResult<PlaylistBody> {
  if (!sharedClipEffects(body).some((f) => sameEffect(f, effect))) return refuse("not every clip has that effect any more");
  const entries = body.entries.map((e) => {
    if (e.kind !== "embedded") return e;
    const i = e.embedded.effects.findIndex((g) => sameEffect(effect, g));
    return { ...e, embedded: { ...e.embedded, effects: e.embedded.effects.filter((_, k) => k !== i) } };
  });
  return accept({ ...body, entries, effects: [...body.effects, { ...structuredClone(effect), id: nextEffectId(body.effects) }] });
}
