// The live debugger's source over the editor's play session (ADR 0373 "In play mode"; T52): the graph Animators of the
// session's Worlds, their newest frames from a recorder (`runtime/features/debug/animatorRecorder.ts`, one Animator at a time:
// the one the debugger shows), parameter edits through `Animator.set`, and the Hierarchy's live selection. The session
// is given as functions (`LocalSession`), so a headless World serves as well as the editor's.
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { Animator } from "../../runtime/components/Animator";
import type { AnimatorDebugFrame, DebugParamValue } from "../../runtime/features/debug/frame";
import { AnimatorRecorder } from "../../runtime/features/debug/animatorRecorder";
import { graphAnimators, paramValue } from "../../runtime/features/debug/targets";
import { graphDebugReport, graphInstanceOf, writtenParameters } from "../../runtime/features/graph/runtime";
import type { AnimationDebugSource, DebugRecording, DebugTarget } from "./source";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

/** @internal What the local source reads of the play session. */
export interface LocalSession {
  worlds(): readonly World[];
  paused(): boolean;
  /** The node selected in the live World shown in the Hierarchy, or null. */
  liveNode(): GameObject | null;
  redraw(): void;
}

/** @internal The play session's source; `dispose` ends its recording. */
export interface LocalDebugSource extends AnimationDebugSource {
  dispose(): void;
}

/** @internal A source over `session`. */
export function createLocalSource(session: LocalSession, options: { seconds?: number } = {}): LocalDebugSource {
  let recorder: AnimatorRecorder | null = null;
  let seconds = options.seconds ?? 10;

  const all = () => graphAnimators(session.worlds());
  const find = (id: string) => all().find((a) => a.id === id) ?? null;
  const recorderFor = (animator: Animator): AnimatorRecorder => {
    if (recorder?.animator !== animator) {
      recorder?.dispose();
      recorder = new AnimatorRecorder(animator, { seconds });
    }
    recorder.poll();
    return recorder;
  };
  /** A frame read now, for an Animator not recorded yet (selected while paused). */
  const now = (animator: Animator): AnimatorDebugFrame | null => {
    const report = graphDebugReport(animator);
    const gi = graphInstanceOf(animator);
    if (!report || !gi) return null;
    const parameters: (DebugParamValue | null)[] = gi.meta.paramTypes.map(() => null);
    for (const [i, v] of writtenParameters(animator, () => true)) parameters[i] = v;
    return { index: -1, time: 0, report, parameters, inputs: [], root: [] };
  };

  const source: LocalDebugSource = {
    name: "Play mode",
    get live() {
      return session.worlds().length > 0;
    },
    get paused() {
      return session.paused();
    },
    targets(graph) {
      const several = session.worlds().length > 1;
      const out: DebugTarget[] = [];
      for (const a of all()) {
        const gi = graphInstanceOf(a.animator);
        if (!gi) continue; // still loading
        const path = normalizeAssetPath(a.animator.graph);
        if (graph !== undefined && path !== normalizeAssetPath(graph)) continue;
        out.push({ id: a.id, label: several ? `${a.animator.node.name} (${a.world.name})` : a.animator.node.name, graph: path, tables: gi.meta.compiled });
      }
      return out;
    },
    selected() {
      const node = session.liveNode();
      const targets = all();
      for (let n: GameObject | null = node; n; n = n.parent) {
        const hit = targets.find((a) => a.animator.node.entity === n!.entity && a.world === n!.world);
        if (hit) return hit.id;
      }
      return null;
    },
    frame(id) {
      const a = find(id);
      if (!a) {
        if (recorder && !all().some((x) => x.animator === recorder!.animator)) source.dispose();
        return null;
      }
      return recorderFor(a.animator).latest ?? now(a.animator);
    },
    recording(id) {
      const a = find(id);
      if (!a) return null;
      const r = recorderFor(a.animator);
      const view: DebugRecording = {
        get frames() {
          return r.frames;
        },
        get seconds() {
          return r.seconds;
        },
        set seconds(s: number) {
          r.seconds = s;
          seconds = r.seconds;
        },
        isKeyframe: (i) => r.isKeyframe(i),
        show: (i) => (i === null || session.paused() ? r.show(i) : false),
        get showing() {
          return r.showing;
        },
      };
      return view;
    },
    set(id, parameter, value) {
      const a = find(id);
      if (!a) return false;
      a.animator.set(parameter, paramValue(value));
      return true;
    },
    redraw: () => session.redraw(),
    dispose() {
      recorder?.dispose();
      recorder = null;
    },
  };
  return source;
}
