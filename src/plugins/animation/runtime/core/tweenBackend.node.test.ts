// ADR 0424: the engine's tween backend over the animation core's table, through the interface its callers use, and the
// same scripts on the standalone tween module's backend: every row, value, weight and change record must match bit for
// bit ("results are identical either way"; native/tween/tests/parity.rs holds the two modules together in Rust too).
// While the plugin is active (the test setup activates it), `openTweenBackend` opens the core's.
import { describe, expect, it } from "vitest";
import { openTweenBackend, type SequenceMember, type TweenBackend, type TweenSpec } from "../../../../engine/tween/backend";
import { openStandaloneTweenBackend } from "../../../../engine/tween/standalone";
import { PASS_FIXED, PASS_NORMAL } from "../../../../engine/tween/wasm/wire/core";
import { FLAG_PLAY, OP_SEEK, OP_STOP, OP_PLAY as SEQ_PLAY, WRAP_LOOP, WRAP_PINGPONG } from "../../../../engine/tween/wasm/wire/sequence";
import {
  EASE_IN_OUT_ELASTIC,
  EASE_OUT_BOUNCE,
  EASE_OUT_QUAD,
  FLAG_YOYO,
  KIND_QUAT_SLERP,
  KIND_VALUE,
  OP_KILL,
  OP_PAUSE,
  OP_RESUME,
  TIME_FIXED,
  TIME_SCALED,
  TIME_UNSCALED,
} from "../../../../engine/tween/wasm/wire/tween";
import { loadAnimationCore } from "./loader";
import { createCoreTweenBackend } from "./tweenBackend";

async function backends(): Promise<[TweenBackend, TweenBackend]> {
  const load = await loadAnimationCore();
  if (load.status !== "ready") throw new Error("this Node runs simd128: the core loads");
  const standalone = await openStandaloneTweenBackend();
  if (!standalone) throw new Error("this Node runs simd128: the standalone module loads");
  return [createCoreTweenBackend(load.core), standalone];
}

const base: TweenSpec = { valueKind: KIND_VALUE, width: 1, ease: EASE_OUT_QUAD, timeMode: TIME_SCALED, loops: 1, duration: 1, speed: 1, from0: 1, to0: 9 };
const member = (hostId: number, offset: number, extra: Partial<SequenceMember> = {}): SequenceMember => ({
  ...base,
  hostId,
  column: hostId,
  offset,
  duration: 0.5,
  ...extra,
});

/** One step of a script; tweens and sequences are named by the order they were made. */
type Op =
  | { readonly curve: readonly [number, number, ("step" | "smooth" | "linear")?][] }
  | { readonly tween: TweenSpec; readonly curveIndex?: number }
  | { readonly control: number; readonly op: number }
  | { readonly sequence: { wrap: number; speed: number }; readonly members: readonly SequenceMember[] }
  | { readonly seqControl: number; readonly op: number; readonly value?: number }
  | { readonly frame: readonly [number, number] };

/** Everything a script produced, as plain numbers (f32 values by their bits). */
function run(b: TweenBackend, script: readonly Op[]): unknown[] {
  const out: unknown[] = [];
  const curves: number[] = [];
  const tweens: number[] = [];
  const seqs: number[] = [];
  const bits = (xs: ArrayLike<number>) => Array.from(new Uint32Array(new Float32Array(Array.from(xs)).buffer));
  for (const op of script) {
    if ("curve" in op) curves.push(b.loadCurve(op.curve.map((k) => [...k]) as never));
    else if ("tween" in op) {
      const h = b.create(op.curveIndex === undefined ? op.tween : { ...op.tween, ease: curves[op.curveIndex]! });
      out.push(["tween", h !== 0, b.lastStatus()]);
      tweens.push(h);
    } else if ("control" in op) out.push(["control", b.control(tweens[op.control]!, op.op)]);
    else if ("sequence" in op) {
      const h = b.createSequence({ hostId: 100 + seqs.length, timeMode: TIME_SCALED, flags: FLAG_PLAY, ...op.sequence }, op.members);
      seqs.push(h);
      const info = b.sequenceInfo(h);
      out.push(["sequence", h !== 0, info?.blocks, info?.duration, b.sequenceBlocks(h).map((x) => [x.kind, x.words, x.column, x.hostId])]);
    } else if ("seqControl" in op) out.push(["seqControl", b.controlSequence(seqs[op.seqControl]!, op.op, op.value)]);
    else {
      for (const pass of [PASS_FIXED, PASS_NORMAL]) {
        b.update(pass, op.frame[0], op.frame[1]);
        const rows = b.rows();
        const changes = Array.from({ length: b.changeCount() }, (_, i) => b.change(i)).map((c) => [c.hostId, c.kind, c.cycle]);
        const outputs = b.sequenceOutputs();
        const seqValues = seqs.map((h) => {
          const info = b.sequenceInfo(h);
          if (!info) return null;
          return [bits(outputs.f32.subarray(info.valueOffset, info.valueOffset + info.valueWords)), bits(outputs.weights.subarray(info.weightOffset, info.weightOffset + info.blocks))];
        });
        const seqChanges = Array.from({ length: b.sequenceChangeCount() }, (_, i) => b.sequenceChange(i)).map((c) => [c.hostId, c.kind, c.member, c.time]);
        out.push([pass, Array.from(rows.columns), bits(rows.values), changes, seqValues, seqChanges, b.activeSequences().length]);
      }
    }
  }
  return out;
}

const frames = (n: number): Op[] => Array.from({ length: n }, (_, i) => ({ frame: [0.05 + 0.031 * (i % 5), 0.07 + 0.013 * (i % 3)] as const }));

describe("the animation core's tween backend", () => {
  it("is what openTweenBackend opens while the plugin is active", async () => {
    const b = await openTweenBackend();
    expect(b?.kind).toBe("core");
    b?.dispose();
  });

  it("gives the standalone module's results for tweens of every kind", async () => {
    const script: Op[] = [
      { curve: [[0, 0, "smooth"], [0.5, 0.8], [1, 1]] },
      { tween: base },
      { tween: { ...base, ease: EASE_IN_OUT_ELASTIC, loops: 3, flags: FLAG_YOYO, delay: 0.2 } },
      { tween: { ...base, ease: EASE_OUT_BOUNCE, timeMode: TIME_UNSCALED, loops: 0xffffffff } },
      { tween: { ...base, timeMode: TIME_FIXED, speed: 1.5 } },
      { tween: { ...base, valueKind: KIND_QUAT_SLERP, width: 4, from0: 0, from3: 1, to0: 0, to1: Math.SQRT1_2, to3: Math.SQRT1_2 } },
      { tween: base, curveIndex: 0 },
      ...frames(5),
      { control: 0, op: OP_PAUSE },
      ...frames(2),
      { control: 0, op: OP_RESUME },
      { control: 2, op: OP_KILL },
      ...frames(25),
    ];
    const [core, standalone] = await backends();
    // Host ids and columns are the script's, so both runs' records carry the same ids.
    const ids = (s: Op[]) => s.map((op, i) => ("tween" in op ? { ...op, tween: { ...op.tween, hostId: i + 1, column: i + 1 } } : op));
    expect(run(core, ids(script))).toEqual(run(standalone, ids(script)));
    core.dispose();
    standalone.dispose();
  });

  it("gives the standalone module's results for sequences, wrap modes and controls", async () => {
    const members = [member(11, 0), member(12, 0.5, { ease: EASE_IN_OUT_ELASTIC, loops: 2, flags: FLAG_YOYO }), member(13, 0.5, { width: 3, to1: 4, to2: -2 })];
    const script: Op[] = [
      { sequence: { wrap: WRAP_LOOP, speed: 1 }, members },
      { sequence: { wrap: WRAP_PINGPONG, speed: -1.5 }, members },
      ...frames(8),
      { seqControl: 0, op: OP_SEEK, value: 0.7 },
      { seqControl: 1, op: OP_STOP },
      ...frames(3),
      { seqControl: 1, op: SEQ_PLAY },
      ...frames(20),
    ];
    const [core, standalone] = await backends();
    expect(run(core, script)).toEqual(run(standalone, script));
    core.dispose();
    standalone.dispose();
  });
});
