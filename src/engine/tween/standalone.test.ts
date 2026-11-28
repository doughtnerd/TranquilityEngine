// ADR 0424: the tween backend over the standalone tween module, through the interface its callers use
// (`openStandaloneTweenBackend`, what `openTweenBackend` opens when no provider is installed: UI animation without the
// animation plugin), in Node with the committed wasm. Times are binary fractions, so values compare exactly.
import { describe, expect, it } from "vitest";
import type { Curve } from "../core/curve";
import { openTweenBackend, TWEEN_BACKEND_PROVIDER, type TweenBackend } from "./backend";
import { createTweenModuleLoader, openStandaloneTweenBackend } from "./standalone";
import { PASS_FIXED, PASS_NORMAL, STATUS_OK, STATUS_STALE_HANDLE } from "./wasm/wire/core";
import { BLOCK_MEMBER, CHANGE_FINISHED, CHANGE_MEMBER_DONE, FLAG_PLAY, NONE, OP_KILL as SEQ_KILL, OP_PAUSE as SEQ_PAUSE, OP_PLAY as SEQ_PLAY, WRAP_ONCE } from "./wasm/wire/sequence";
import { CHANGE_COMPLETED, CHANGE_KILLED, EASE_LINEAR, KIND_VALUE, OP_KILL, OP_PAUSE, OP_RESUME, TIME_FIXED, TIME_SCALED, TIME_UNSCALED } from "./wasm/wire/tween";

async function open(): Promise<TweenBackend> {
  const backend = await openStandaloneTweenBackend();
  if (!backend) throw new Error("this Node runs simd128: the standalone backend opens");
  return backend;
}

const linear = { valueKind: KIND_VALUE, width: 1, ease: EASE_LINEAR, timeMode: TIME_SCALED, loops: 1, duration: 1, speed: 1, from0: 0, to0: 8 };

/** The first value of each row, by column. */
function values(b: TweenBackend): Map<number, number> {
  const rows = b.rows();
  return new Map(Array.from({ length: rows.count }, (_, i) => [rows.columns[i]!, rows.values[i * 4]!]));
}

function changes(b: TweenBackend): { hostId: number; kind: number }[] {
  return Array.from({ length: b.changeCount() }, (_, i) => b.change(i)).map((c) => ({ hostId: c.hostId, kind: c.kind }));
}

describe("the standalone tween backend", () => {
  it("is the standalone module's", async () => {
    const b = await open();
    expect(b.kind).toBe("standalone");
    b.dispose();
  });

  it("runs a tween to its end and reports it completed", async () => {
    const b = await open();
    const h = b.create({ ...linear, hostId: 7, column: 7 });
    expect(h).not.toBe(0);
    const seen: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      b.update(PASS_NORMAL, 0.25, 0.25);
      seen.push(values(b).get(7));
      if (i < 3) expect(changes(b)).toEqual([]);
    }
    expect(seen).toEqual([2, 4, 6, 8]);
    expect(changes(b)).toEqual([{ hostId: 7, kind: CHANGE_COMPLETED }]);
    expect(b.control(h, OP_PAUSE)).toBe(STATUS_STALE_HANDLE);
    b.dispose();
  });

  it("pauses, resumes and kills, and keeps time modes to their clock and pass", async () => {
    const b = await open();
    const scaled = b.create({ ...linear, hostId: 1, column: 1 });
    b.create({ ...linear, hostId: 2, column: 2, timeMode: TIME_UNSCALED });
    b.create({ ...linear, hostId: 3, column: 3, timeMode: TIME_FIXED });
    b.update(PASS_NORMAL, 0.25, 0.5);
    expect(values(b)).toEqual(new Map([[1, 2], [2, 4]]));
    b.update(PASS_FIXED, 0.125, 0.125);
    expect(values(b)).toEqual(new Map([[3, 1]]));
    expect(b.control(scaled, OP_PAUSE)).toBe(STATUS_OK);
    b.update(PASS_NORMAL, 0.25, 0.25);
    expect(values(b).has(1)).toBe(false);
    expect(b.control(scaled, OP_RESUME)).toBe(STATUS_OK);
    b.update(PASS_NORMAL, 0.25, 0.25);
    expect(values(b).get(1)).toBe(4);
    expect(b.control(scaled, OP_KILL)).toBe(STATUS_OK);
    b.update(PASS_NORMAL, 0.25, 0.25);
    expect(changes(b)).toContainEqual({ hostId: 1, kind: CHANGE_KILLED });
    b.dispose();
  });

  it("eases through a curve it loaded, and frees it", async () => {
    const b = await open();
    // Steps to 1 at x = 0.5: half way the tween jumps from `from` to `to`.
    const curve: Curve = [
      [0, 0, "step"],
      [0.5, 1, "step"],
    ];
    const c = b.loadCurve(curve);
    expect(c).toBeGreaterThanOrEqual(1 << 16);
    b.create({ ...linear, hostId: 4, column: 4, ease: c });
    b.update(PASS_NORMAL, 0.25, 0.25);
    expect(values(b).get(4)).toBe(0);
    b.update(PASS_NORMAL, 0.5, 0.5);
    expect(values(b).get(4)).toBe(8);
    expect(b.releaseCurve(c)).toBe(true);
    expect(b.releaseCurve(c)).toBe(false);
    b.dispose();
  });

  it("never starts a member placed after an endless one (offset Infinity): encodeSequence clamps it to the largest f32 (ADR 0470)", async () => {
    const b = await open();
    const h = b.createSequence({ hostId: 40, timeMode: TIME_SCALED, wrap: WRAP_ONCE, flags: FLAG_PLAY, speed: 1 }, [
      { ...linear, hostId: 41, column: 41, offset: 0, duration: 0.5 },
      { ...linear, hostId: 42, column: 42, offset: Infinity, duration: 0.5 },
    ]);
    expect(h, `status ${b.lastStatus()}`).not.toBe(0);
    const info = b.sequenceInfo(h)!;
    const blocks = b.sequenceBlocks(h);
    expect(blocks.map((x) => x.hostId)).toEqual([41, 42]);
    b.update(PASS_NORMAL, 0.25, 0.25);
    // The second member hasn't started (an offset the module read as non-finite would have placed it at 0).
    const out = b.sequenceOutputs();
    expect(blocks.map((x) => out.weights[info.weightOffset + x.index])).toEqual([1, 0]);
    expect(info.duration).toBeGreaterThan(1e38);
    b.controlSequence(h, SEQ_KILL);
    b.update(PASS_NORMAL, 0, 0); // its kill is reported here, not in the next test's frames
    b.dispose();
  });

  it("plays a sequence: member blocks, values and weights, completions in order, then finished", async () => {
    const b = await open();
    const h = b.createSequence({ hostId: 10, timeMode: TIME_SCALED, wrap: WRAP_ONCE, flags: FLAG_PLAY, speed: 1 }, [
      { ...linear, hostId: 11, column: 11, offset: 0, duration: 0.5 },
      { ...linear, hostId: 12, column: 12, offset: 0.5, duration: 0.5, from0: 8, to0: 0 },
    ]);
    expect(h).not.toBe(0);
    const info = b.sequenceInfo(h)!;
    expect(info.blocks).toBe(2);
    expect(info.duration).toBe(1);
    const blocks = b.sequenceBlocks(h);
    expect(blocks.map((x) => [x.kind, x.hostId, x.column, x.words])).toEqual([
      [BLOCK_MEMBER, 11, 11, 1],
      [BLOCK_MEMBER, 12, 12, 1],
    ]);
    const frame = (dt: number) => {
      b.update(PASS_NORMAL, dt, dt);
      const out = b.sequenceOutputs();
      const records = Array.from({ length: b.sequenceChangeCount() }, (_, i) => b.sequenceChange(i)).map((c) => [c.kind, c.member]);
      return {
        values: blocks.map((x) => out.f32[info.valueOffset + x.offset]),
        weights: blocks.map((x) => out.weights[info.weightOffset + x.index]),
        active: [...b.activeSequences()],
        records,
      };
    };
    expect(frame(0.25)).toEqual({ values: [4, 0], weights: [1, 0], active: [h], records: [] });
    expect(frame(0.5)).toEqual({ values: [8, 4], weights: [1, 1], active: [h], records: [[CHANGE_MEMBER_DONE, 11]] });
    expect(b.controlSequence(h, SEQ_PAUSE)).toBe(STATUS_OK);
    expect(frame(0.25).active).toEqual([]);
    expect(b.controlSequence(h, SEQ_PLAY)).toBe(STATUS_OK);
    expect(frame(0.25)).toEqual({
      values: [8, 0],
      weights: [1, 1],
      active: [h],
      records: [
        [CHANGE_MEMBER_DONE, 12],
        [CHANGE_FINISHED, NONE],
      ],
    });
    // A sequence that plays once retires when it finishes.
    expect(b.sequenceInfo(h)).toBeNull();
    b.dispose();
  });

  it("keeps backends apart: each update advances only its own tweens", async () => {
    const a = await open();
    const b = await open();
    a.create({ ...linear, hostId: 21, column: 21 });
    b.create({ ...linear, hostId: 22, column: 22 });
    a.update(PASS_NORMAL, 0.25, 0.25);
    expect(values(a)).toEqual(new Map([[21, 2]]));
    b.update(PASS_NORMAL, 0.5, 0.5);
    expect(values(b)).toEqual(new Map([[22, 4]]));
    a.dispose();
    b.dispose();
  });

  it("creates nothing once disposed", async () => {
    const b = await open();
    b.dispose();
    expect(b.create({ ...linear, hostId: 30, column: 30 })).toBe(0);
    expect(b.createSequence({ hostId: 31, wrap: WRAP_ONCE, flags: FLAG_PLAY, speed: 1 }, [])).toBe(0);
    expect(b.loadCurve([[0, 0]])).toBe(0);
  });

  it("is what openTweenBackend opens through the latest installed provider, until it is removed", async () => {
    const mine = await open();
    const undo = TWEEN_BACKEND_PROVIDER.register(() => Promise.resolve(mine));
    expect(await openTweenBackend()).toBe(mine);
    undo();
    const other = await openTweenBackend();
    expect(other).not.toBe(mine);
    mine.dispose();
    other?.dispose();
  });

  it("loads the module once, never without simd128, and tries a failed load again", async () => {
    let calls = 0;
    const none = createTweenModuleLoader({
      supportsSimd: () => false,
      instantiate: () => {
        calls++;
        return Promise.reject(new Error("must not instantiate"));
      },
    });
    expect(await none()).toBeNull();
    expect(calls).toBe(0);
    const failing = createTweenModuleLoader({
      supportsSimd: () => true,
      instantiate: () => {
        calls++;
        return Promise.reject(new Error("offline"));
      },
    });
    await expect(failing()).rejects.toThrow("offline");
    await expect(failing()).rejects.toThrow("offline");
    expect(calls).toBe(2);
  });
});
