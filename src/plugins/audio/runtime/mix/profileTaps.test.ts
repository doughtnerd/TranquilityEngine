// ADR 0171 (Rc3, api-and-models §5.6 kinds 11, 14, 15): the mixer's setter taps through `mixerTapFor`, on the real `Mixer`
// with a recording stub sink. A busRamp is the lane's name, its frames (a 0-second write is `BUS_MIN_RAMP_MS` long on the
// wire) and its target; a write that changes nothing taps nothing; a mixer with no tap pays one null check.
import { describe, expect, it } from "vitest";
import { BUS_MIN_RAMP_MS, DRAG_RAMP_MS, Mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { NULL_PROFILE_SINK } from "./profileSink";
import { mixerTapFor, taps, wireProfileTaps } from "./profileTaps";
import { recordingSink } from "./recordingSink";
import { VoiceTable } from "../core/voiceTable";

const RATE = 48_000;
const SLOT: Record<string, number> = { Master: 0, Music: 1, SFX: 2 };
/** gen 3 on every slot, so a test tells a busRef from a slot. */
const ref = (bus: string): number => (3 << 8) | SLOT[bus]!;
const settings = () =>
  parseAudioSettings({
    buses: [{ name: "Master" }, { name: "Music", parent: "Master", volume: 0.8 }, { name: "SFX", parent: "Master" }],
    snapshots: [{ name: "Paused", volumes: { Music: 0.5 } }],
  }).settings;

function rig() {
  const mixer = new Mixer(settings());
  const stub = recordingSink();
  mixer._setTap(mixerTapFor(stub.sink, () => RATE, ref));
  return { mixer, stub };
}

describe("the mixer's setter taps (§5.6 kinds 11, 14, 15)", () => {
  it("Bus.volume and Bus.fadeTo tap the runtime lane: asap is BUS_MIN_RAMP_MS long, a fade its seconds", () => {
    const { mixer, stub } = rig();
    mixer.bus("SFX").volume = 0.5;
    mixer.bus("Music").fadeTo(0.25, 2);
    expect(stub.calls).toEqual([
      ["busRamp", ref("SFX"), "runtime", Math.round((BUS_MIN_RAMP_MS / 1000) * RATE), 0.5],
      ["busRamp", ref("Music"), "runtime", 2 * RATE, 0.25],
    ]);
  });

  it("setting a lane to the value it holds taps nothing", () => {
    const { mixer, stub } = rig();
    mixer.bus("SFX").volume = 1;
    expect(stub.calls).toEqual([]);
  });

  it("Bus.mute taps the runtime lane at 0, and unmuting taps the script's volume", () => {
    const { mixer, stub } = rig();
    mixer.bus("SFX").volume = 0.5;
    stub.clear();
    mixer.bus("SFX").mute = true;
    mixer.bus("SFX").mute = false;
    mixer.bus("SFX").mute = false; // no change, no tap
    expect(stub.calls.map((c) => c[4])).toEqual([0, 0.5]);
    expect(stub.calls.every((c) => c[0] === "busRamp" && c[2] === "runtime" && c[3] === Math.round((BUS_MIN_RAMP_MS / 1000) * RATE))).toBe(true);
  });

  it("a snapshot taps one snapshot record and a snapshot-lane ramp per bus that moves; clearing it is the empty name", () => {
    const { mixer, stub } = rig();
    mixer.snapshot("Paused", 0.5);
    expect(stub.of("snapshot")).toEqual([["Paused", 0.5]]);
    expect(stub.of("busRamp")).toEqual([[ref("Music"), "snapshot", Math.round(0.5 * RATE), 0.5]]);
    stub.clear();
    mixer.clearSnapshot(0.25);
    expect(stub.of("snapshot")).toEqual([["", 0.25]]);
    expect(stub.of("busRamp")).toEqual([[ref("Music"), "snapshot", Math.round(0.25 * RATE), 1]]);
  });

  it("an unknown snapshot taps nothing", () => {
    const { mixer, stub } = rig();
    const warn = console.warn;
    console.warn = () => {};
    try { mixer.snapshot("Nope"); } finally { console.warn = warn; }
    expect(stub.calls).toEqual([]);
  });

  it("the structural dip taps the dip lane", () => {
    const { mixer, stub } = rig();
    mixer._setDip("Music", 0, 0.02);
    expect(stub.calls).toEqual([["busRamp", ref("Music"), "dip", Math.round(0.02 * RATE), 0]]);
  });

  it("a live authored edit taps the authored lane over the drag ramp; an authored mute taps 0", () => {
    const { mixer, stub } = rig();
    mixer._applyLive({ op: "setBus", bus: "Music", key: "volume", value: 0.4 });
    mixer._applyLive({ op: "setBus", bus: "Music", key: "mute", value: true });
    expect(stub.calls).toEqual([
      ["busRamp", ref("Music"), "authored", Math.round((DRAG_RAMP_MS / 1000) * RATE), 0.4],
      ["busRamp", ref("Music"), "authored", Math.round((BUS_MIN_RAMP_MS / 1000) * RATE), 0],
    ]);
  });

  it("monitor mute and solo tap one mask word: mutes in the low 16 bits, solos in the high 16 (by bus slot)", () => {
    const { mixer, stub } = rig();
    mixer.setMonitor("Music", { mute: true });
    mixer.setMonitor("SFX", { solo: true });
    mixer.setMonitor("SFX", { solo: true }); // unchanged
    mixer.setMonitor("Music", { mute: false });
    expect(stub.calls).toEqual([["monitor", 1 << 1], ["monitor", ((1 << 2) << 16 | (1 << 1)) >>> 0], ["monitor", (1 << 2) << 16]]);
  });

  it("with no tap (the default) every setter works and nothing is reported", () => {
    const mixer = new Mixer(settings());
    mixer.bus("SFX").volume = 0.5;
    mixer.snapshot("Paused", 0);
    mixer.setMonitor("Music", { mute: true });
    expect(mixer.bus("SFX").volume).toBe(0.5);
  });
});

describe("wireProfileTaps", () => {
  it("points the table, the mixer and the page-wide taps at one sink, and null restores every null object", () => {
    const mixer = new Mixer(settings());
    const table = new VoiceTable(4);
    const stub = recordingSink();
    wireProfileTaps(stub.sink, { table, mixer, names: { clip: String as never, busRef: (i: number) => i }, sampleRate: () => RATE, busRef: ref });
    expect(table.profile).toBe(stub.sink);
    expect(taps.sink).toBe(stub.sink);
    mixer.bus("SFX").volume = 0.5;
    expect(stub.of("busRamp")).toHaveLength(1);
    wireProfileTaps(null, { table, mixer, names: { clip: String as never, busRef: (i: number) => i }, sampleRate: () => RATE, busRef: ref });
    expect(table.profile).toBe(NULL_PROFILE_SINK);
    expect(taps.sink).toBe(NULL_PROFILE_SINK);
    mixer.bus("SFX").volume = 0.25;
    expect(stub.of("busRamp")).toHaveLength(1);
  });
});
