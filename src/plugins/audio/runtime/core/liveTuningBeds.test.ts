// ADR 0162 E7 (#158): the `audio.bed.*` settings and a bus's `bed` / `bedPriority` after a running World's settings change.
// `Engine.create` hands the one mixer a new settings object (`mixer.configure`) and tells the audio host; with the same bus
// names the host reports no remap, so the core backend must re-plan the beds itself (beds.ts: "runs when the bus tree,
// `audio.bed.maxBeds`, a bus's `bed` or `bedPriority` changes"). `maxBeds` above the slots the core laid out stays
// capped by them (the core's memory is sized at init: it applies at the next rebuild).
import { afterEach, describe, expect, it } from "vitest";
import { defaultAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import { BED_HOST_NONE, BED_SLOT_NONE } from "../wire.generated";
import { closeRecordingAudio, fakeHostClock, recordingAudio } from "../testing";

const bus = (name: string, parent?: string, extra: Partial<BusSettings> = {}): BusSettings => ({ name, ...(parent ? { parent } : null), volume: 1, mute: false, effects: [], ...extra });

function settingsWith(buses: BusSettings[], maxBeds = 4): AudioSettings {
  const s = defaultAudioSettings();
  s.buses = buses;
  s.bed = { maxBeds };
  return s;
}

/** The core backend on the recording host (ADR 0234), over its own mixer, with `laidOut` bed slots in the core. */
function rig(first: AudioSettings, laidOut = 2) {
  const r = recordingAudio({ mixer: "own", settings: first, preset: { maxLogical: 16, maxBeds: laidOut }, clock: fakeHostClock({ currentTime: 1 }) });
  const { backend, mixer } = r;
  /** What `Engine.create` does to a running audio system: the mixer takes the new settings, then the next frame runs. */
  const reconfigure = (next: AudioSettings) => {
    mixer.configure(next);
    mixer.update(0.016);
    r.tick(0.016);
  };
  const planned = () => ({ slots: [...backend.beds.bedSlot.subarray(0, mixer.audioSettings.buses.length)], hosts: [...backend.beds.hostBus.subarray(0, backend.beds.slotCount)], count: backend.beds.slotCount });
  return { backend, reconfigure, planned };
}

const NONE = BED_SLOT_NONE;

afterEach(closeRecordingAudio);

describe("bed settings after a settings change with the same buses", () => {
  const tree = (amb: Partial<BusSettings> = {}) => [bus("Master"), bus("Ambience", "Master", amb), bus("SFX", "Master")];

  it("a bus's bed mode and priority: parent to own gives it a slot, none takes it away", () => {
    const r = rig(settingsWith(tree()));
    expect(r.planned()).toEqual({ slots: [0, 0, 0], hosts: [0], count: 1 });
    r.reconfigure(settingsWith(tree({ bed: "own", bedPriority: 200 })));
    expect(r.planned()).toEqual({ slots: [0, 1, 0], hosts: [0, 1], count: 2 });
    r.reconfigure(settingsWith(tree({ bed: "none" })));
    expect(r.planned().slots).toEqual([0, NONE, 0]);
    expect(r.planned().count).toBe(1);
  });

  it("maxBeds: lowering it frees the beds above it; raising it (up to the slots the core laid out) gives them back", () => {
    const r = rig(settingsWith(tree({ bed: "own", bedPriority: 200 }), 4));
    expect(r.planned().count).toBe(2);
    r.reconfigure(settingsWith(tree({ bed: "own", bedPriority: 200 }), 1));
    expect(r.planned()).toEqual({ slots: [0, 0, 0], hosts: [0], count: 1 });
    r.reconfigure(settingsWith(tree({ bed: "own", bedPriority: 200 }), 4));
    expect(r.planned().count).toBe(2);
    r.reconfigure(settingsWith(tree({ bed: "own", bedPriority: 200 }), 0));
    expect(r.planned()).toEqual({ slots: [NONE, NONE, NONE], hosts: [], count: 0 });
  });

  it("a settings change that keeps the beds the same plans nothing new", () => {
    const r = rig(settingsWith(tree({ bed: "own", bedPriority: 200 })));
    const before = r.planned();
    r.reconfigure(settingsWith(tree({ bed: "own", bedPriority: 200 })));
    expect(r.planned()).toEqual(before);
    expect(BED_HOST_NONE).toBeGreaterThan(0);
  });
});
