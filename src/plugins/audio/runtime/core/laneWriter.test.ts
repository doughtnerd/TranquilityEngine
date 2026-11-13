// ADR 0171 amended by 0172 (Mx2; api-and-models §3.1, §4.2; architecture §4.5): the per-lane writer against a real `Mixer`
// and a recording writer. Each setter emits a BUS_RAMP for exactly the lane that moved, with its law: a fade stamped at
// F_now + L for its exact length, sets and toggles asap over `rampFrames`; MASTER on BUS_MASTER_OUT's runtime lane; the
// replay resends every lane (remaining ramps, end states); selection's bus factor is the lane product down the tree.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  BUS_MASTER_OUT,
  BUS_RAMP_MASK_GAIN,
  BUS_RAMP_MASK_LP_HZ,
  LANE_AUTHORED,
  LANE_DIP,
  LANE_MONITOR,
  LANE_RUNTIME,
  LANE_SNAPSHOT,
  Op,
  readBusRamp,
} from "../wire.generated";
import { LaneWriter, type LaneWriterHost } from "./laneWriter";
import { ReplayBuilder } from "./replay";

const RATE = 48_000;
const NOW_FRAME = 100_000;
const LOOKAHEAD = 1_024;
const RAMP = 480;
const MIN = 240; // BUS_MIN_RAMP_MS at 48 kHz

type Call = { bus: number; lane: number; mask: number; gain: number; lpHz: number; frames: number; seq: number; at: number | undefined };

function settings(): AudioSettings {
  return {
    ...defaultAudioSettings(),
    buses: [
      { name: "Master", volume: 1, mute: false, effects: [] },
      { name: "Music", parent: "Master", volume: 0.6, mute: false, effects: [] },
      { name: "SFX", parent: "Master", volume: 1, mute: false, effects: [] },
    ],
    snapshots: [{ name: "Under", volumes: { Music: 0.5 }, lowpass: { Music: 800 } }],
  };
}

function rig() {
  const mixer = new Mixer(settings());
  const heard = { t: 2 };
  mixer.setClock(() => heard.t);
  const calls: Call[] = [];
  let shared = 0;
  const clock = { framesNow: NOW_FRAME };
  const host: LaneWriterHost = {
    mixer,
    writer: { busRampFrames: (bus, lane, mask, gain, lpHz, frames, seq = 0, at) => void calls.push({ bus, lane, mask, gain, lpHz, frames, seq, at }) },
    clockMap: {
      rampFrames: () => RAMP,
      framesNow: () => clock.framesNow,
      lookaheadFrames: () => LOOKAHEAD,
      sampleRate: RATE,
      frameOfTime: (at) => (at === undefined ? 0 : Math.round(at * RATE)),
      stampFor: (f) => (f > clock.framesNow ? f : undefined),
    },
    busIndexByName: new Map([["Master", 0], ["Music", 1], ["SFX", 2]]),
    busGain: new Float32Array(32).fill(1),
    refreshSharedLowpass: () => void shared++,
  };
  const lanes = new LaneWriter(host);
  lanes.sync(); // the configure's full send
  const take = () => calls.splice(0);
  take();
  return { mixer, heard, lanes, host, take, clock, shared: () => shared };
}

describe("LaneWriter.sync: one BUS_RAMP per lane that moved", () => {
  it("the first sync (a configure) sends every lane of every bus asap over rampFrames", () => {
    const mixer = new Mixer(settings());
    const calls: Call[] = [];
    const lanes = new LaneWriter({
      mixer,
      writer: { busRampFrames: (bus, lane, mask, gain, lpHz, frames, seq = 0, at) => void calls.push({ bus, lane, mask, gain, lpHz, frames, seq, at }) },
      clockMap: { rampFrames: () => RAMP, framesNow: () => NOW_FRAME, lookaheadFrames: () => LOOKAHEAD, sampleRate: RATE, frameOfTime: () => 0, stampFor: () => undefined },
      busIndexByName: new Map([["Master", 0], ["Music", 1], ["SFX", 2]]),
      busGain: new Float32Array(32),
      refreshSharedLowpass: () => {},
    });
    lanes.sync();
    expect(calls.map((c) => [c.bus, c.lane, c.mask, c.gain, c.lpHz, c.frames, c.at])).toEqual(
      [0, 1, 2].flatMap((b) => [
        [b, LANE_AUTHORED, BUS_RAMP_MASK_GAIN, b === 1 ? 0.6 : 1, BUS_LP_OFF_HZ, RAMP, undefined],
        [b, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, 1, BUS_LP_OFF_HZ, RAMP, undefined],
        [b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, 1, BUS_LP_OFF_HZ, RAMP, undefined],
        [b, LANE_MONITOR, BUS_RAMP_MASK_GAIN, 1, BUS_LP_OFF_HZ, RAMP, undefined],
        [b, LANE_DIP, BUS_RAMP_MASK_GAIN, 1, BUS_LP_OFF_HZ, RAMP, undefined],
      ]),
    );
    // Nothing moved since: nothing more.
    calls.length = 0;
    lanes.sync();
    expect(calls).toEqual([]);
    // `forget` (a new BUS_CONFIG) resends everything.
    lanes.forget();
    lanes.sync();
    expect(calls).toHaveLength(15);
  });

  it("fadeTo: one runtime-lane ramp stamped at F_now + L for its exact length; the frames it runs send nothing", () => {
    const r = rig();
    r.mixer.bus("Music").fadeTo(0.25, 0.5);
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 1, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0.25, lpHz: BUS_LP_OFF_HZ, frames: 24_000, seq: 0, at: NOW_FRAME + LOOKAHEAD }]);
    expect(r.lanes.lastRampStartFrame(1)).toBe(NOW_FRAME + LOOKAHEAD);
    expect(r.lanes.lastRampStartFrame(2)).toBeUndefined();
    // The fade advances on the heard clock: nothing new to send.
    r.heard.t += 0.1;
    r.mixer.update(0.1);
    r.lanes.sync();
    expect(r.take()).toEqual([]);
  });

  it("a fade shorter than BUS_MIN_RAMP_MS is floored to it; a fade before the clock has an estimate goes asap", () => {
    const r = rig();
    r.mixer.bus("SFX").fadeTo(0.5, 0.001);
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 2, lane: LANE_RUNTIME, frames: MIN, at: NOW_FRAME + LOOKAHEAD }]);
    r.clock.framesNow = 0;
    r.mixer.bus("SFX").fadeTo(1, 0.5);
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 2, lane: LANE_RUNTIME, gain: 1, frames: 24_000, at: undefined }]);
  });

  it("a volume set goes asap over rampFrames (today's length); re-setting the same value sends nothing", () => {
    const r = rig();
    r.mixer.bus("Music").volume = 0.5;
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 1, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0.5, lpHz: BUS_LP_OFF_HZ, frames: RAMP, seq: 0, at: undefined }]);
    r.mixer.bus("Music").volume = 0.5;
    r.lanes.sync();
    expect(r.take()).toEqual([]);
  });

  it("script mute: the runtime lane to 0 asap; a fade while muted is held; the unmute resends what is left of it", () => {
    const r = rig();
    r.mixer.bus("SFX").mute = true;
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 2, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0, lpHz: BUS_LP_OFF_HZ, frames: RAMP, seq: 0, at: undefined }]);
    r.mixer.bus("SFX").fadeTo(0.5, 1);
    r.lanes.sync();
    expect(r.take()).toEqual([]);
    r.heard.t += 0.25;
    r.mixer.bus("SFX").mute = false;
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 2, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0.5, lpHz: BUS_LP_OFF_HZ, frames: 36_000, seq: 0, at: undefined }]);
    // Unmuted with no fade running: back to the value over rampFrames.
    r.heard.t += 1;
    r.mixer.bus("SFX").mute = true;
    r.lanes.sync();
    r.take();
    r.mixer.bus("SFX").mute = false;
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 2, lane: LANE_RUNTIME, gain: 0.5, frames: RAMP, at: undefined }]);
  });

  it("solo: the monitor lane of every bus the solo silences goes to 0 asap, and back on release", () => {
    const r = rig();
    r.mixer.bus("Music").solo = true;
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 2, lane: LANE_MONITOR, mask: BUS_RAMP_MASK_GAIN, gain: 0, lpHz: BUS_LP_OFF_HZ, frames: RAMP, seq: 0, at: undefined }]);
    r.mixer.bus("Music").solo = false;
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 2, lane: LANE_MONITOR, gain: 1, frames: RAMP }]);
  });

  it("monitor mute and monitor solo (the Mixer panel) write the monitor lane asap", () => {
    const r = rig();
    r.mixer.setMonitor("Music", { mute: true });
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 1, lane: LANE_MONITOR, gain: 0, frames: RAMP, at: undefined }]);
    // Unmuted, but a monitor solo on SFX silences it: still 0, nothing to send.
    r.mixer.setMonitor("Music", { mute: false });
    r.mixer.setMonitor("SFX", { solo: true });
    r.lanes.sync();
    expect(r.take()).toEqual([]);
    r.mixer.setMonitor("SFX", { solo: false });
    r.lanes.sync();
    expect(r.take()).toMatchObject([{ bus: 1, lane: LANE_MONITOR, gain: 1, frames: RAMP, at: undefined }]);
  });

  it("snapshot: gain and low-pass on the snapshot lane in one record, stamped for the transition's length; a 0 s one asap", () => {
    const r = rig();
    r.mixer.snapshot("Under", 0.25);
    r.lanes.sync();
    const calls = r.take();
    expect(calls).toContainEqual({ bus: 1, lane: LANE_SNAPSHOT, mask: BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, gain: 0.5, lpHz: 800, frames: 12_000, seq: 0, at: NOW_FRAME + LOOKAHEAD });
    // Buses the snapshot leaves at 1 were already at 1: nothing for them.
    expect(calls).toHaveLength(1);
    r.heard.t += 1;
    r.mixer.clearSnapshot(0);
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 1, lane: LANE_SNAPSHOT, mask: BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, gain: 1, lpHz: BUS_LP_OFF_HZ, frames: RAMP, seq: 0, at: undefined }]);
  });

  it("the dip lane is stamped like a fade", () => {
    const r = rig();
    r.mixer._setDip("SFX", 0, 0.02);
    r.lanes.sync();
    expect(r.take()).toEqual([{ bus: 2, lane: LANE_DIP, mask: BUS_RAMP_MASK_GAIN, gain: 0, lpHz: BUS_LP_OFF_HZ, frames: 960, seq: 0, at: NOW_FRAME + LOOKAHEAD }]);
  });

  it("selection's bus factor is the lane product down the tree (authored x runtime x snapshot x monitor x dip x duck), times automation", () => {
    const r = rig();
    expect(Array.from(r.host.busGain.subarray(0, 3))).toEqual([1, Math.fround(0.6), 1]);
    r.mixer.bus("Master").volume = 0.5;
    r.mixer.snapshot("Under", 0);
    r.lanes.sync();
    expect(r.host.busGain[1]).toBeCloseTo(0.5 * 0.6 * 0.5, 6);
    expect(r.host.busGain[2]).toBeCloseTo(0.5, 6);
    // Mid-fade: the value now on the heard clock.
    r.mixer.bus("SFX").fadeTo(0, 1);
    r.heard.t += 0.5;
    r.lanes.sync();
    expect(r.host.busGain[2]).toBeCloseTo(0.25, 6);
    r.mixer.bus("Music").solo = true;
    r.lanes.sync();
    expect(r.host.busGain[2]).toBe(0);
    r.lanes.selAuto[1] = 0.5;
    r.lanes.refreshBusGain();
    expect(r.host.busGain[1]).toBeCloseTo(0.5 * 0.6 * 0.5 * 0.5, 6);
    expect(r.lanes.snapLp[1]).toBe(800);
    expect(r.shared()).toBeGreaterThan(0);
  });
});

describe("LaneWriter keys what it sent by slot (Ma2)", () => {
  it("a live rename sends no lane record (the slot and its state are the same bus)", () => {
    // Fails before Ma2: the writer keyed its sent state on the bus name, so a rename restated all five lanes of the slot.
    const r = rig();
    const map = r.host.busIndexByName as Map<string, number>;
    r.mixer._applyLive({ op: "renameBus", from: "SFX", to: "Effects" });
    map.delete("SFX");
    map.set("Effects", 2);
    map.set("SFX", 2); // the old name aliases the slot
    r.lanes.sync();
    expect(r.take()).toEqual([]);
    // The renamed bus's lanes still go out on its slot when they move.
    r.mixer.bus("Effects").volume = 0.5;
    r.lanes.sync();
    expect(r.take()).toEqual([expect.objectContaining({ bus: 2, lane: LANE_RUNTIME, gain: 0.5 })]);
  });

  it("a removed bus (a tombstone) sends nothing, even when its dip lane is set to 0; selection reads it silent", () => {
    const r = rig();
    const map = r.host.busIndexByName as Map<string, number>;
    r.mixer._applyLive({ op: "removeBus", bus: "SFX" });
    map.delete("SFX");
    r.mixer._setDip("SFX", 0, 0);
    r.lanes.sync();
    expect(r.take()).toEqual([]);
    expect(r.host.busGain[2]).toBe(0);
  });

  it("a new bus on a reused slot sends every lane on that slot; the stale state there is skipped", () => {
    const r = rig();
    const map = r.host.busIndexByName as Map<string, number>;
    r.mixer._applyLive({ op: "removeBus", bus: "SFX" });
    map.delete("SFX");
    r.lanes.sync();
    r.mixer._applyLive({ op: "addBus", name: "Amb", parent: "Music" }, 2); // the recycled slot 2, listed after the stale SFX
    map.set("Amb", 2);
    r.lanes.sync();
    const sent = r.take();
    expect(sent.map((c) => [c.bus, c.lane])).toEqual([
      [2, LANE_AUTHORED],
      [2, LANE_RUNTIME],
      [2, LANE_SNAPSHOT],
      [2, LANE_MONITOR],
      [2, LANE_DIP],
    ]);
    // Amb is under Music (slot 1, volume 0.6): selection follows the slot's parent, not the list position.
    expect(r.host.busGain[2]).toBeCloseTo(0.6, 6);
  });

  it("selection's chain walks up the tree when a re-parent puts the parent at a higher slot", () => {
    const r = rig();
    const map = r.host.busIndexByName as Map<string, number>;
    r.mixer._applyLive({ op: "addBus", name: "Late", parent: "Master" }, 3);
    map.set("Late", 3);
    r.mixer._applyLive({ op: "moveBus", bus: "Music", parent: "Late" });
    r.lanes.sync();
    r.lanes.selAuto[3] = 0.5;
    r.lanes.refreshBusGain();
    expect(r.host.busGain[1]).toBeCloseTo(0.6 * 0.5, 6);
  });
});

describe("LaneWriter.master and rampLane", () => {
  it("MASTER goes as BUS_RAMP on BUS_MASTER_OUT's runtime lane, target volume x not muted", () => {
    const r = rig();
    r.lanes.master(0.25, false, RAMP);
    r.lanes.master(0.25, true, 2_400);
    expect(r.take()).toEqual([
      { bus: BUS_MASTER_OUT, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0.25, lpHz: BUS_LP_OFF_HZ, frames: RAMP, seq: 0, at: undefined },
      { bus: BUS_MASTER_OUT, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0, lpHz: BUS_LP_OFF_HZ, frames: 2_400, seq: 0, at: undefined },
    ]);
  });

  it("rampLane: by name or the output, the mask from the fields, stamped at `at` when ahead, else asap", () => {
    const r = rig();
    r.lanes.rampLane({ bus: "SFX", lane: "dip", gain: 0, seconds: 0.02, at: 3, sequenceId: 9 });
    r.lanes.rampLane({ bus: null, lane: "runtime", gain: 0.5, seconds: 0 });
    r.lanes.rampLane({ bus: "Music", lane: "snapshot", lpHz: 500, seconds: 0.1, at: 1 }); // past: asap
    r.lanes.rampLane({ bus: "Nope", lane: "authored", gain: 1, seconds: 0 });
    expect(r.take()).toEqual([
      { bus: 2, lane: LANE_DIP, mask: BUS_RAMP_MASK_GAIN, gain: 0, lpHz: BUS_LP_OFF_HZ, frames: 960, seq: 9, at: 144_000 },
      { bus: BUS_MASTER_OUT, lane: LANE_RUNTIME, mask: BUS_RAMP_MASK_GAIN, gain: 0.5, lpHz: BUS_LP_OFF_HZ, frames: 0, seq: 0, at: undefined },
      { bus: 1, lane: LANE_SNAPSHOT, mask: BUS_RAMP_MASK_LP_HZ, gain: 1, lpHz: 500, frames: 4_800, seq: 0, at: undefined },
    ]);
    expect(r.lanes.lastRampStartFrame(2)).toBe(144_000);
  });
});

describe("LaneWriter.replayLanes (§4.2: after RESET and BUS_CONFIG)", () => {
  /** The BUS_RAMP records a builder holds. */
  const records = (b: ReplayBuilder) => {
    const out: ReturnType<typeof readBusRamp>[] = [];
    const posted: ArrayBuffer[] = [];
    b.post({ post: (m) => posted.push(m), nextSeq: () => 1 }, 0, true);
    for (const m of posted) {
      const view = new DataView(m);
      for (let off = 32; off < view.byteLength; off += view.getUint16(off + 2, true) * 4) {
        expect(view.getUint16(off, true)).toBe(Op.BUS_RAMP);
        out.push(readBusRamp(view, off));
      }
    }
    return out;
  };

  it("every lane of every bus, asap: steps at their value, a running fade as its remaining ramp, a dip at its end state", () => {
    const r = rig();
    r.mixer.bus("Music").fadeTo(0, 2); // 0.25 done at the replay
    r.mixer.snapshot("Under", 1); // half done
    r.mixer.bus("SFX").mute = true;
    r.mixer._setDip("SFX", 0.5, 0.02); // ends before the replay
    r.lanes.sync();
    r.take();
    r.heard.t += 0.5;
    const b = new ReplayBuilder();
    r.lanes.replayLanes(b);
    const recs = records(b).map((x) => [x.voiceId, x.lane, x.mask, x.gain, x.lpHz, x.frames, x.frameOffset]);
    const G = BUS_RAMP_MASK_GAIN;
    const GL = BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ;
    expect(recs).toEqual([
      [0, LANE_AUTHORED, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [0, LANE_RUNTIME, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [0, LANE_SNAPSHOT, GL, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [0, LANE_MONITOR, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [0, LANE_DIP, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [1, LANE_AUTHORED, G, Math.fround(0.6), BUS_LP_OFF_HZ, 0, ASAP],
      [1, LANE_RUNTIME, G, 0.75, BUS_LP_OFF_HZ, 0, ASAP],
      [1, LANE_RUNTIME, G, 0, BUS_LP_OFF_HZ, 72_000, ASAP],
      [1, LANE_SNAPSHOT, GL, 0.75, 12_400, 0, ASAP],
      [1, LANE_SNAPSHOT, GL, 0.5, 800, 24_000, ASAP],
      [1, LANE_MONITOR, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [1, LANE_DIP, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [2, LANE_AUTHORED, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [2, LANE_RUNTIME, G, 0, BUS_LP_OFF_HZ, 0, ASAP],
      [2, LANE_SNAPSHOT, GL, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [2, LANE_MONITOR, G, 1, BUS_LP_OFF_HZ, 0, ASAP],
      [2, LANE_DIP, G, 0.5, BUS_LP_OFF_HZ, 0, ASAP],
    ]);
    // What was replayed is what the core holds: the next sync sends nothing.
    r.lanes.sync();
    expect(r.take()).toEqual([]);
  });
});
