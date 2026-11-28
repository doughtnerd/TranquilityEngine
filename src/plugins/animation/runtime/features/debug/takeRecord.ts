// The animation take source (ADR 0348, 0373; T73): while a take records, every graph Animator running in the Engine's
// Worlds is followed by a T52 recorder (`recorder.ts`) whose entries are written into the take as animation records
// (`frameRecord.ts`, `takeRecords.ts`): the frame (`ANIM_FRAME`: inputs, report, parameters, root motion, as the live
// debugger shows it), the rows and commands the core applied (`ANIM_RAW`), and about once a second the instance's snapshot
// before the frame (`ANIM_KEY`), so the editor can re-evaluate any frame from the nearest keyframe against the project as
// it is then. An Animator that starts while the take records is picked up at the next frame start; at most
// `TAKE_MAX_TARGETS` are recorded (the first ones). Loaded by `import()` from the registration (`register.ts`), only by a
// take that starts.
import type { TakeSource, TakeSourceHost, TakeSourceRun } from "../../../../../engine/audio/take/extensions";
import type { Animator } from "../../components/Animator";
import { graphInstanceOf } from "../graph/runtime";
import { animatorRuntime } from "../instances";
import { ANIM_FRAME, ANIM_KEY, ANIM_RAW, ANIM_SELECT, ANIM_TARGET, encodeFrameRecord } from "./frameRecord";
import { AnimatorRecorder, type RecordedEntry } from "./animatorRecorder";
import { graphAnimators,} from "./targets";
import { RawEncoder, TAKE_MAX_TARGETS, encodeKey, encodeSelect, encodeTarget, graphHash } from "./takeRecords";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

/** Seconds between keyframes in a take (the recorder's default). */
export const TAKE_KEYFRAME_SECONDS = 1;

interface Followed {
  readonly id: number;
  readonly recorder: AnimatorRecorder;
  readonly raw: RawEncoder;
  /** The graph hash the last `ANIM_TARGET` declared (a different one declares again). */
  declared: number | null;
}

/** @internal The source a take starts. */
export const animationTakeSource: TakeSource = {
  start(host: TakeSourceHost): TakeSourceRun {
    const followed = new Map<Animator, Followed>();
    const worlds = () => host.engine.worlds().flatMap((h) => host.engine._world(h.name) ?? []);
    let current = -1;
    let nextId = 0;
    let stopped = false;

    const write = (follow: Followed, entry: RecordedEntry): void => {
      if (stopped) return;
      const gi = graphInstanceOf(follow.recorder.animator);
      if (!gi) return;
      const hash = graphHash(gi.meta.compiled.bytes);
      if (follow.declared !== hash) {
        const several = worlds().length > 1;
        const node = follow.recorder.animator.node;
        const info = { id: follow.id, label: several ? `${node.name} (${node.world.name})` : node.name, graph: normalizeAssetPath(follow.recorder.animator.graph), graphHash: hash, bones: animatorRuntime(follow.recorder.animator)?.skeleton?.info?.bones ?? 0, tables: gi.meta.compiled };
        const payload = encodeTarget(info);
        if (!payload) {
          console.warn(`[myco] Audio.take: the graph of "${node.name}" has tables too large to record; its animation isn't in the take.`);
          return;
        }
        host.write(ANIM_TARGET, payload);
        follow.declared = hash;
        current = follow.id;
      } else if (current !== follow.id) {
        host.write(ANIM_SELECT, encodeSelect(follow.id));
        current = follow.id;
      }
      if (entry.key) host.write(ANIM_KEY, encodeKey(entry.frame.index, entry.key));
      const raw = follow.raw.encode(entry.frame.index, entry.raw, entry.before);
      if (raw) host.write(ANIM_RAW, raw);
      host.write(ANIM_FRAME, encodeFrameRecord(entry.frame));
    };

    const attach = (): void => {
      for (const a of graphAnimators(worlds())) {
        const f = followed.get(a.animator);
        if (f) {
          f.recorder.poll(); // a new instance (re-activation) is followed again
          continue;
        }
        if (followed.size >= TAKE_MAX_TARGETS) continue;
        let follow: Followed | undefined;
        const recorder = new AnimatorRecorder(a.animator, { seconds: 1, keyframeEvery: TAKE_KEYFRAME_SECONDS, onEntry: (e) => follow && write(follow, e) });
        follow = { id: nextId++, raw: new RawEncoder(), declared: null, recorder };
        followed.set(a.animator, follow);
      }
    };

    attach();
    const unhook = host.engine._addFrameHook({ begin: attach });
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        unhook();
        for (const f of followed.values()) f.recorder.dispose();
        followed.clear();
      },
    };
  },
};
