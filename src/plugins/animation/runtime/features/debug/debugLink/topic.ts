// The debug link's `animation` topic (ADR 0376; the live debugger of 0373 against a connected build, T60). A build with
// debugging on serves it; the editor's debugger reads it through `editor/debugger/linkSource.ts`:
//
// - request `targets` `{ graph? }`: the graph Animators running (`graph` a project path narrows them), each with its id,
//   label, graph path and the graph's compiled tables (without the graph's bytes), as the play session lists them;
// - subscription `{ target }`: that Animator's frames, recorded by the T52 recorder in the build and sent as
//   `ANIM_FRAME` records (`../frameRecord.ts`), every frame since the last sample, so a rate-limited sample loses none;
// - commands, applied at the build's next frame start: `set` `{ target, parameter, value }` (`Animator.set`), `travel`
//   and `jump` `{ target, state, layer? }`.
//
// It leaves the instances' graph debug flag as the graph runtime sets it (on): it only reads reports.
// Loaded only by `import()` from the runtime context's registration (`../register.ts`), so release exports hold none of it.
import type { World } from "../../../../../../engine/core/World";
import type { DebugSubscription, DebugTopic, DebugTopicHost } from "../../../../../../engine/debugLink/topics";
import { graphInstanceOf } from "../../graph/runtime";
import { ANIM_FRAME, encodeFrameRecord } from "../frameRecord";
import { AnimatorRecorder } from "../animatorRecorder";
import { graphAnimators, paramValue, wireParamValue } from "../targets";
import { normalizeAssetPath } from "../../../../../../engine/scene/assetPath";

/** Samples per second each subscription sends at most (every frame since the last one goes in each). */
export const ANIMATION_TOPIC_RATE = 30;
/** Seconds the build's recorder keeps (it only has to hold what wasn't sent yet). */
const KEEP_SECONDS = 1;

/** @internal The animation topic for a build's link. */
export function animationTopic(host: DebugTopicHost): DebugTopic {
  const worlds = (): World[] => host.engine.worlds().flatMap((h) => host.engine._world(h.name) ?? []);
  const find = (id: unknown) => (typeof id === "string" ? (graphAnimators(worlds()).find((a) => a.id === id) ?? null) : null);
  const field = (params: unknown, name: string): unknown => (params && typeof params === "object" ? (params as Record<string, unknown>)[name] : undefined);

  return {
    rate: ANIMATION_TOPIC_RATE,
    request(method, params) {
      if (method !== "targets") throw new Error(`The animation topic has no "${method}" request.`);
      const graph = field(params, "graph");
      const several = worlds().length > 1;
      const out = [];
      for (const a of graphAnimators(worlds())) {
        const gi = graphInstanceOf(a.animator);
        if (!gi) continue; // still loading
        const path = normalizeAssetPath(a.animator.graph);
        if (typeof graph === "string" && path !== normalizeAssetPath(graph)) continue;
        out.push({ id: a.id, label: several ? `${a.animator.node.name} (${a.world.name})` : a.animator.node.name, graph: path, tables: { ...gi.meta.compiled, bytes: null } });
      }
      return out;
    },
    subscribe(params): DebugSubscription | { refused: string } {
      const id = field(params, "target");
      const a = find(id);
      if (!a) return { refused: `There's no graph Animator "${String(id)}" running.` };
      const recorder = new AnimatorRecorder(a.animator, { seconds: KEEP_SECONDS });
      let sent = -1;
      let seq = 0;
      return {
        sample(out, frame) {
          if (!recorder.poll()) return;
          for (const f of recorder.frames) {
            if (f.index <= sent) continue;
            out.write(ANIM_FRAME, seq++, frame, encodeFrameRecord(f));
            sent = f.index;
          }
        },
        close: () => recorder.dispose(),
      };
    },
    command(name, params) {
      const a = find(field(params, "target"));
      if (!a) throw new Error(`There's no graph Animator "${String(field(params, "target"))}" running.`);
      if (name === "set") {
        const parameter = field(params, "parameter");
        const value = wireParamValue(field(params, "value"));
        if (typeof parameter !== "string" || value === null) throw new Error("set needs a parameter name and a number, boolean or vector value.");
        a.animator.set(parameter, paramValue(value));
        return;
      }
      if (name === "travel" || name === "jump") {
        const state = field(params, "state");
        const layer = field(params, "layer");
        if (typeof state !== "string") throw new Error(`${name} needs a state name.`);
        const options = typeof layer === "number" || typeof layer === "string" ? { layer } : {};
        if (name === "travel") void a.animator.travel(state, options as Parameters<typeof a.animator.travel>[1]);
        else a.animator.jump(state, options as Parameters<typeof a.animator.jump>[1]);
        return;
      }
      throw new Error(`The animation topic has no "${name}" command.`);
    },
  };
}
