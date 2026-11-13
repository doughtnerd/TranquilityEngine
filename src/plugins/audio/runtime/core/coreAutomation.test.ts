// ADR 0158 E3.1: the core backend's automation sink (`coreAutomation.ts`) against a recording writer and a real voice
// table: what goes out when, voices resolved by id (C6), the per-frame resync budget, the mirror's REPLAY records,
// selection's view of automated gain, and the region-aware wrap.
import { describe, expect, it } from "vitest";
import type { Curve } from "../../../../engine/core/curve";
import { AutoTarget, type Binding } from "../events/automation";
import { Kind, Op, readEnvelope, readRecordHead } from "../wire.generated";
import type { AudioVoice } from "../backend";
import { CommandWriter, CORE_CURVE_KEYS, STAGING_BYTES, AUTOMATION_GLOBAL } from "./commandWriter";
import { BufferPool } from "./bufferPool";
import { CoreAutomation, RESYNC_BYTES_PER_FRAME, wrapPosition, type CoreAutomationDeps } from "./coreAutomation";
import { ReplayBuilder } from "./replay";
import { Selection } from "./selection";
import { VoiceFlag, VoiceState, VoiceTable } from "./voiceTable";
import type { ClipInfo } from "./clipRegistry";

type Call = [string, ...unknown[]];

function rig(options: { sending?: boolean; writer?: CoreAutomationDeps["writer"] } = {}) {
  const table = new VoiceTable(16);
  const calls: Call[] = [];
  const writer: CoreAutomationDeps["writer"] = options.writer ?? {
    automate: (id, at, b) => void calls.push(["automate", id, at, b.map((x) => ({ ...x }))]),
    param: (g, s, v, seek) => void calls.push(["param", g, s, v, seek]),
    curves: (first, cs) => void calls.push(["curves", first, cs.length]),
    busAutomate: (bus, b) => void calls.push(["busAutomate", bus, b.map((x) => ({ ...x }))]),
    setLoop: (id, at, s, e, l) => void calls.push(["setLoop", id, at, s, e, l]),
  };
  const anchors: [number, number, number][] = [];
  const retimes: number[] = [];
  const state = { sending: options.sending ?? true, now: 10_000, pos: 0 };
  const info: ClipInfo = { id: 1, path: "a.wav", state: "ready", refs: 1, frames: 96_000, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null };
  const buses = new Map([["Master", 0], ["SFX", 1], ["Music", 2]]);
  const auto = new CoreAutomation({
    table,
    writer,
    clockMap: { framesNow: () => state.now, lookaheadFrames: () => 1000 },
    playheads: { positionNow: () => state.pos, start: (i, f, p) => void anchors.push([i, f, p]), retime: (i) => void retimes.push(i) },
    clipInfo: () => info,
    busIndex: (name) => buses.get(name) ?? -1,
    sending: () => state.sending,
  });
  /** A voice on the core (PLAYING), in `group`. */
  const voice = (group = 0, s: number = VoiceState.PLAYING): AudioVoice => {
    const id = table.allocate(0, 128, 0, s as never);
    table.group[id & 0xffff] = group;
    return { id } as AudioVoice;
  };
  return { table, calls, auto, state, anchors, retimes, buses, voice };
}

const vol = (slot: number, curve: number, global = false): Binding => ({ param: { global, slot }, curve, target: AutoTarget.Volume });
const fullCurve = (seed: number): Curve => Array.from({ length: CORE_CURVE_KEYS }, (_, k) => [k, seed + k / 100] as const);

describe("CoreAutomation: the sink over the writer (E3.1)", () => {
  it("sends CURVES, PARAM, AUTOMATE (with the PLAY's stamp) and BUS_AUTOMATE", () => {
    const { auto, calls, voice } = rig();
    auto.defineCurve(3, [[0, 0], [1, 1]]);
    auto.setParam(5, 2, 0.5, 4);
    const v = voice(5);
    auto.onPlaySent(v.id, v.id & 0xffff, 12_345);
    auto.bindVoice(v, 5, [vol(2, 3)], { volume: 1, pitch: 1 });
    auto.bindBus("Music", [vol(1, 3, true), { param: { global: false, slot: 0 }, curve: 3, target: AutoTarget.Volume }]);
    expect(calls).toEqual([
      ["curves", 3, 1],
      ["param", 5, 2, 0.5, 4],
      ["automate", v.id, 12_345, [{ param: 2, curve: 3, target: AutoTarget.Volume }]],
      // Local and pitch bindings are not for buses.
      ["busAutomate", 2, [{ param: AUTOMATION_GLOBAL | 1, curve: 3, target: AutoTarget.Volume }]],
    ]);
  });

  it("holds a voice's bindings and loop until its PLAY goes out, then sends them behind it", () => {
    const { auto, calls, voice } = rig();
    const v = voice(1, VoiceState.WAITING_FOR_DATA);
    auto.bindVoice(v, 1, [vol(0, 0)], { volume: 1, pitch: 1 });
    auto.setLoop(v, 0.5, 1.5, true);
    expect(calls).toEqual([]);
    const t = (auto as unknown as { deps: { table: VoiceTable } }).deps.table;
    t.state[v.id & 0xffff] = VoiceState.PLAYING;
    auto.onPlaySent(v.id, v.id & 0xffff, 20_000);
    expect(calls).toEqual([
      ["automate", v.id, 20_000, [{ param: 0, curve: 0, target: AutoTarget.Volume }]],
      ["setLoop", v.id, 20_000, 24_000, 72_000, true],
    ]);
  });

  it("resolves voices by id, never by class: a forwarding wrapper (a PendingVoice after the hand-over) works; a dead id is ignored", () => {
    const { auto, calls, voice, table } = rig();
    const inner = voice(2);
    const wrapper = { get id() { return inner.id; }, playing: true } as unknown as AudioVoice;
    auto.bindVoice(wrapper, 2, [vol(1, 4)], { volume: 1, pitch: 1 });
    expect(calls).toEqual([["automate", inner.id, undefined, [{ param: 1, curve: 4, target: AutoTarget.Volume }]]]);
    table.free(inner.id, 0);
    auto.forget(inner.id & 0xffff);
    calls.length = 0;
    auto.bindVoice(wrapper, 2, [vol(1, 4)], { volume: 1, pitch: 1 });
    auto.setLoop(wrapper, 0, 0, false);
    auto.bindVoice({ id: 0x7fff_0001 } as AudioVoice, 2, [vol(1, 4)], { volume: 1, pitch: 1 });
    expect(calls).toEqual([]);
  });

  it("stamps a loop or release behind a PLAY still ahead, else asap; a release re-anchors the playhead inside the region", () => {
    const { auto, calls, voice, state, anchors } = rig();
    const v = voice(1);
    const i = v.id & 0xffff;
    auto.onPlaySent(v.id, i, 30_000);
    auto.setLoop(v, 0.5, 1, true);
    expect(calls.at(-1)).toEqual(["setLoop", v.id, 30_000, 24_000, 48_000, true]);
    state.now = 200_000;
    state.pos = 24_000 + 3 * 24_000 + 100; // three passes of the region, plus 100 frames
    auto.setLoop(v, 0.5, 1, false);
    expect(calls.at(-1)).toEqual(["setLoop", v.id, undefined, 24_000, 48_000, false]);
    expect(anchors.at(-1)).toEqual([i, 201_000, 24_100]);
    expect(auto.loopOf(i)).toEqual({ start: 24_000, end: 48_000, looping: false });
  });

  it("keeps a stream voice's loop in the mirror without SET_LOOP (E4.4 routes streams)", () => {
    const { auto, calls, voice, table } = rig();
    const v = voice(1);
    table.flags[v.id & 0xffff] |= VoiceFlag.STREAM;
    auto.setLoop(v, 1, 2, true);
    expect(calls).toEqual([]);
    expect(auto.loopOf(v.id & 0xffff)).toEqual({ start: 48_000, end: 96_000, looping: true });
  });

  it("sends what a binding reads ahead of its AUTOMATE when the resync hasn't yet", () => {
    const { auto, calls, voice } = rig();
    auto.setParam(0, 3, 0.25, 0);
    auto.defineCurve(7, [[0, 1]]);
    auto.afterReset(); // everything pending again, no budget this frame
    calls.length = 0;
    const v = voice(0);
    auto.bindVoice(v, 0, [vol(3, 7, true)], { volume: 1, pitch: 1 });
    expect(calls).toEqual([
      ["curves", 7, 1],
      ["param", 0, 3, 0.25, 0],
      ["automate", v.id, undefined, [{ param: AUTOMATION_GLOBAL | 3, curve: 7, target: AutoTarget.Volume }]],
    ]);
    auto.beginFrame();
    expect(calls).toHaveLength(3); // nothing else was pending
  });

  it("re-sends bus bindings at the new indices after a remap, clearing the old index", () => {
    const { auto, calls, buses } = rig();
    auto.defineCurve(0, [[0, 1]]);
    auto.bindBus("Music", [vol(0, 0, true)]);
    calls.length = 0;
    buses.set("Music", 1);
    buses.set("SFX", 2);
    auto.onBusesConfigured();
    expect(calls).toEqual([
      ["busAutomate", 2, []],
      ["busAutomate", 1, [{ param: AUTOMATION_GLOBAL, curve: 0, target: AutoTarget.Volume }]],
    ]);
  });

  it("a live rename moves a bus's bindings to the new name (Ma1): removing them afterwards clears the slot", () => {
    const { auto, calls, buses } = rig();
    auto.defineCurve(0, [[0, 1]]);
    auto.bindBus("Music", [vol(0, 0, true)]);
    // The slot table keeps Music's slot (2) under the new name; the old name aliases it.
    buses.set("Score", 2);
    auto.renameBus("Music", "Score");
    calls.length = 0;
    // The event runtime binds the new name again from the settings: the rule was removed, so with nothing.
    auto.bindBus("Score", []);
    expect(calls).toEqual([["busAutomate", 2, []]]);
    // A later configure (the alias gone) sends nothing for the old name: no binding is left behind for a replay.
    calls.length = 0;
    buses.delete("Music");
    auto.onBusesConfigured();
    expect(calls).toEqual([]);
  });

  it("while a rebuild runs only the mirror changes", () => {
    const { auto, calls, voice } = rig({ sending: false });
    auto.defineCurve(0, [[0, 1]]);
    auto.setParam(0, 0, 1, 0);
    const v = voice(0);
    auto.bindVoice(v, 0, [vol(0, 0, true)], { volume: 1, pitch: 1 });
    auto.bindBus("SFX", [vol(0, 0, true)]);
    expect(calls).toEqual([]);
    expect(auto.counts).toEqual({ curves: 1, voices: 1, pending: 2 });
  });
});

describe("CoreAutomation: bulk uploads and the mirror's replay", () => {
  function realWriter() {
    const posted: ArrayBuffer[] = [];
    const pool = new BufferPool(4, 64 * 1024);
    let seq = 0;
    const writer = new CommandWriter({ batchPool: pool, nextSeq: () => seq++, post: (b) => void posted.push(b) }, 48_000);
    /** Curves uploaded in the batches posted so far (the posted buffers go back to the pool, as the worklet's would). */
    const curvesIn = (): number => {
      let n = 0;
      for (const b of posted.splice(0)) {
        const view = new DataView(b);
        expect(readEnvelope(view, 0).kind).toBe(Kind.BATCH);
        const count = view.getUint32(16 + 8, true);
        let off = 32;
        for (let r = 0; r < count; r++) {
          const head = readRecordHead(view, off);
          if (head.opcode === Op.CURVES) n += view.getUint32(off + 16, true);
          off += head.words * 4;
        }
        pool.release(b);
      }
      return n;
    };
    return { writer, curvesIn };
  }

  it("spreads a full 1,024-curve table over frames: nothing dropped past the 256 KB staging area", () => {
    const { writer, curvesIn } = realWriter();
    const { auto } = rig({ writer });
    const total = 1024 * (4 + 12 * CORE_CURVE_KEYS);
    expect(total).toBeGreaterThan(STAGING_BYTES); // the reason for the spread
    for (let id = 0; id < 1024; id++) auto.defineCurve(id, fullCurve(id));
    let sent = curvesIn();
    let frames = 0;
    while (auto.counts.pending > 0 && frames < 100) {
      writer.flush(0);
      sent += curvesIn();
      auto.beginFrame();
      frames++;
    }
    writer.flush(0);
    sent += curvesIn();
    expect(writer.stats.dropped).toBe(0);
    expect(sent).toBe(1024);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(total / RESYNC_BYTES_PER_FRAME) - 1);
  });

  it("replays a 1,024-curve mirror, the parameters and the bus bindings in the header REPLAY; bindings and loops after each PLAY", () => {
    const { auto, voice } = rig({ sending: false });
    for (let id = 0; id < 1024; id++) auto.defineCurve(id, fullCurve(id));
    auto.setParam(0, 1, 0.75, 3);
    auto.setParam(9, 15, 2, 0);
    auto.bindBus("SFX", [vol(1, 1023, true)]);
    const v = voice(9);
    auto.bindVoice(v, 9, [vol(15, 1022)], { volume: 1, pitch: 1 });
    auto.setLoop(v, 0.25, 0, true);

    const b = new ReplayBuilder();
    auto.replayHeader(b);
    auto.replayVoice(b, v.id, v.id & 0xffff);
    const posted: ArrayBuffer[] = [];
    b.post({ post: (m) => void posted.push(m), nextSeq: () => 0 }, 0, false);
    const ops: number[] = [];
    let curves = 0;
    const params: [number, number, number, number][] = [];
    for (const m of posted) {
      const view = new DataView(m);
      expect(readEnvelope(view, 0).kind).toBe(Kind.REPLAY);
      const count = view.getUint32(16 + 8, true);
      let off = 32;
      for (let r = 0; r < count; r++) {
        const head = readRecordHead(view, off);
        ops.push(head.opcode);
        if (head.opcode === Op.CURVES) {
          expect(head.words * 4).toBeLessThanOrEqual(32 * 1024);
          curves += view.getUint32(off + 16, true);
        }
        if (head.opcode === Op.PARAM) params.push([view.getUint16(off + 12, true), view.getUint16(off + 14, true), view.getFloat32(off + 16, true), view.getFloat32(off + 20, true)]);
        off += head.words * 4;
      }
    }
    expect(curves).toBe(1024);
    // At their targets, jumping (seek 0).
    expect(params).toEqual([[0, 1, 0.75, 0], [9, 15, 2, 0]]);
    const tail = ops.filter((o) => o !== Op.CURVES);
    expect(tail).toEqual([Op.PARAM, Op.PARAM, Op.BUS_AUTOMATE, Op.AUTOMATE, Op.SET_LOOP]);
    // Every curve comes before the first binding.
    expect(ops.lastIndexOf(Op.CURVES)).toBeLessThan(ops.indexOf(Op.PARAM));
    expect(auto.counts.pending).toBe(0);
  });
});

describe("CoreAutomation: selection sees automated gain (0158 §3)", () => {
  it("evaluates the bound curves at a parameter's target: a voice whose automated gain drops to ~0 loses audibility", () => {
    const { auto, voice, table, retimes, state } = rig();
    const selection = new Selection(table);
    selection.busGain.fill(1);
    auto.defineCurve(0, [[0, 0], [10, 1]]);
    auto.defineCurve(1, [[0, 1], [1, 2]]);
    auto.setParam(4, 0, 10, 5);
    const v = voice(4);
    const other = voice(0);
    const i = v.id & 0xffff;
    for (const k of [i, other.id & 0xffff]) table.gain[k] = 1;
    auto.bindVoice(v, 4, [vol(0, 0), { param: { global: true, slot: 2 }, curve: 1, target: AutoTarget.Pitch }], { volume: 1, pitch: 1 });
    expect(table.autoGain[i]).toBe(1);
    const loud = selection.audibilityOf(i);
    expect(loud).toBeCloseTo(selection.audibilityOf(other.id & 0xffff), 6);
    // E4.5 (decision 14): while the seek (10 -> 0.001 at 5 a second: 2 s) runs, selection still sees the voice at its
    // smoothed gain; it loses audibility when the fade ends.
    auto.setParam(4, 0, 0.001, 5);
    expect(table.autoGain[i]).toBeCloseTo(1, 6);
    expect(selection.audibilityOf(i)).toBeCloseTo(loud, 6);
    state.now += 96_000;
    auto.beginFrame();
    expect(table.autoGain[i]).toBeCloseTo(0.0001, 6);
    expect(selection.audibilityOf(i)).toBeLessThan(loud * 0.001);
    // Another instance's parameter doesn't touch it; a global one its pitch reads does (and retimes the playhead).
    auto.setParam(5, 0, 10, 0);
    expect(table.autoGain[i]).toBeCloseTo(0.0001, 6);
    auto.setParam(0, 2, 1, 0);
    expect(table.autoPitch[i]).toBe(2);
    expect(retimes).toContain(i);
    // Freed: back to neutral.
    table.free(v.id, 0);
    auto.forget(i);
    expect(table.autoGain[i]).toBe(1);
    expect(table.autoPitch[i]).toBe(1);
  });
});

describe("wrapPosition (C6, for E4.4)", () => {
  it("wraps an unwrapped playhead into the loop region", () => {
    expect(wrapPosition(500, 1000, 2000, 3000)).toBe(500);
    expect(wrapPosition(1999, 1000, 2000, 3000)).toBe(1999);
    expect(wrapPosition(2000, 1000, 2000, 3000)).toBe(1000);
    expect(wrapPosition(4250, 1000, 2000, 3000)).toBe(1250);
    // End 0 (or past the clip) is the clip's end; an empty region loops the whole clip, as the core does.
    expect(wrapPosition(3500, 1000, 0, 3000)).toBe(1500);
    expect(wrapPosition(3500, 1000, 9000, 3000)).toBe(1500);
    expect(wrapPosition(3500, 2000, 1000, 3000)).toBe(500);
    expect(wrapPosition(3500, 0, 0, 0)).toBe(3500);
  });
});

