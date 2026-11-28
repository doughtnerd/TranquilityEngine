// The live debugger's source over a take (ADR 0348, 0373; T73): a take's recorded Animators read as a running game's, so the
// graph overlay, the (read-only) live parameters and the recorder bar work on a take as on a play session
// (`localSource.ts`) or a connected build (`linkSource.ts`). The take's frames are all there is to scrub (no ring that
// trims), the newest frame is its last, and the source is always "paused": scrubbing shows the frame's graph, and its pose
// where a running Animator of the same graph can show it.
//
// **Against the current project.** A frame's overlay, parameters and inputs are what the build recorded and need only the
// take's own tables. A pose is re-evaluated (`takeReplay.ts`) from the nearest keyframe in a scratch instance of the
// project's graph and skeleton, so it shows what the project does now with the recorded inputs. When the graph changed
// since the take (`takeCompat.ts`), the source says what changed and shows no poses rather than a wrong one; when only
// clips changed, the poses are the project's own with the take's inputs (they differ from the recorded ones, on purpose).
import type { CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import type { Animator } from "../../runtime/components/Animator";
import type { AnimatorDebugFrame } from "../../runtime/features/debug/frame";
import { compareGraph, type TakeCompat } from "../../runtime/features/debug/takeCompat";
import type { AnimationTake, AnimationTakeTarget } from "../../runtime/features/debug/takeRead";
import { TakeReplayer, currentGraphOf } from "../../runtime/features/debug/takeReplay";
import type { AnimationDebugSource, DebugRecording, DebugTarget } from "./source";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

/** @internal What the take source reads of the editor. */
export interface TakeSession {
  /** A running graph Animator of the project whose graph is `graph` (a project path), where the take's poses can be shown (the play session's, paused); null when none runs. */
  animator(graph: string): Animator | null;
  redraw(): void;
}

/** @internal The take's source; `dispose` frees what poses re-evaluated. */
export interface TakeDebugSource extends AnimationDebugSource {
  readonly take: AnimationTake;
  /** How the project stands against `target`'s recording now. */
  compat(target: string): TakeCompat;
  dispose(): void;
}

/** @internal A source over `take`, opened as `name` (the file's name). */
export function createTakeSource(take: AnimationTake, session: TakeSession, name: string): TakeDebugSource {
  const byId = new Map<string, AnimationTakeTarget>();
  const listed: DebugTarget[] = take.targets.map((t) => {
    const id = String(t.info.id);
    byId.set(id, t);
    return { id, label: t.info.label, graph: normalizeAssetPath(t.info.graph), tables: t.info.tables as CompiledAnimGraph };
  });
  const frames = new Map<string, readonly AnimatorDebugFrame[]>(take.targets.map((t) => [String(t.info.id), t.entries.map((e) => e.frame)]));
  const keys = new Map<string, ReadonlySet<number>>(take.targets.map((t) => [String(t.info.id), new Set(t.entries.filter((e) => e.key).map((e) => e.frame.index))]));
  const replayers = new Map<string, TakeReplayer>();
  let disposed = false;

  const compat = (id: string): TakeCompat => {
    const t = byId.get(id);
    if (!t) return { poses: false, notes: [] };
    const animator = session.animator(normalizeAssetPath(t.info.graph));
    if (!animator) {
      const lead = t.changedWhileRecording ? compareGraph(t.info, null, true).notes.slice(0, 1) : [];
      return { poses: false, notes: [...lead, `No Animator runs "${normalizeAssetPath(t.info.graph)}" now: play the scene and pause it to see this take's poses.`] };
    }
    return compareGraph(t.info, currentGraphOf(animator), t.changedWhileRecording);
  };
  const replayerFor = (id: string, animator: Animator): TakeReplayer | null => {
    const t = byId.get(id);
    if (!t) return null;
    let r = replayers.get(id);
    if (r && r.animator !== animator) {
      r.dispose();
      replayers.delete(id);
      r = undefined;
    }
    if (!r) {
      r = new TakeReplayer(t, animator);
      replayers.set(id, r);
    }
    return r;
  };

  const source: TakeDebugSource = {
    take,
    name: `Take ${name}`,
    get live() {
      return !disposed && listed.length > 0;
    },
    paused: true,
    readOnly: true,
    targets(graph) {
      return graph === undefined ? listed : listed.filter((t) => t.graph === normalizeAssetPath(graph));
    },
    selected: () => null,
    frame: (id) => frames.get(id)?.at(-1) ?? null,
    recording(id) {
      const all = frames.get(id);
      const t = byId.get(id);
      if (!all || !t) return null;
      const span = all.length > 0 ? all[all.length - 1]!.time - all[0]!.time : 0;
      const view: DebugRecording = {
        frames: all,
        get seconds() {
          return Math.max(1, span);
        },
        set seconds(_s: number) {
          // A take keeps everything it recorded.
        },
        isKeyframe: (index) => keys.get(id)?.has(index) ?? false,
        show(index) {
          if (index === null) {
            for (const r of replayers.values()) r.show(null);
            return true;
          }
          const animator = session.animator(normalizeAssetPath(t.info.graph));
          if (!animator || !compat(id).poses) return false;
          const r = replayerFor(id, animator);
          return r?.show(index) ?? false;
        },
        get showing() {
          for (const r of replayers.values()) if (r.target === t) return r.showing;
          return null;
        },
      };
      return view;
    },
    set: () => false,
    redraw: () => session.redraw(),
    notes(id) {
      const t = byId.get(id);
      if (!t) return [];
      return [...compat(id).notes, ...take.problems];
    },
    compat,
    dispose() {
      disposed = true;
      for (const r of replayers.values()) r.dispose();
      replayers.clear();
    },
  };
  return source;
}
