// ADR 0162 E7 (#158): the `audio.bed.*` settings and a bus's `bed` / `bedPriority` after a running World's settings change.
// `Engine.create` hands the one mixer a new settings object (`mixer.configure`) and tells the audio host; with the same bus
// names the host reports no remap, so the core backend must re-plan the beds itself (beds.ts: "runs when the bus tree,
// `audio.bed.maxBeds`, a bus's `bed` or `bedPriority` changes"). `maxBeds` above the slots the core laid out stays
// capped by them (the core's memory is sized at init: it applies at the next rebuild).
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import { BED_HOST_NONE, BED_SLOT_NONE } from "../wire.generated";
import { CoreLink, type AudioHost, type HostLifecycleListener, type LinkPort } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import type { ClipRegistry } from "./clipRegistry";

const bus = (name: string, parent?: string, extra: Partial<BusSettings> = {}): BusSettings => ({ name, ...(parent ? { parent } : null), volume: 1, mute: false, effects: [], ...extra });

function settingsWith(buses: BusSettings[], maxBeds = 4): AudioSettings {
  const s = defaultAudioSettings();
  s.buses = buses;
  s.bed = { maxBeds };
  return s;
}

function rig(first: AudioSettings, laidOut = 2) {
  const port: LinkPort = { onmessage: null, postMessage: () => {} };
  const lifecycle: HostLifecycleListener[] = [];
  const host: CoreBackendHost = {
    link: new CoreLink(port),
    status: "running",
    preset: { maxLogical: 16, maxBeds: laidOut },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => (lifecycle.push(l), () => {})) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(first);
  const clock = { rafTime: () => 1000, outputTimestamp: () => ({ contextTime: 1, performanceTime: 1000 }), currentTime: () => 1, dateNow: () => 1_001_000, fake: true as const };
  const clips = { acquire: () => 1, release() {}, state: () => "ready", info: () => null, onResident: () => () => {}, releaseWorld() {}, acquireReserved() {}, applyClipEvent() {}, residentIds: () => [] } as unknown as ClipRegistry;
  const backend = new CoreBackend(host, { clips, clock, mixer });
  /** What `Engine.create` does to a running audio system: the mixer takes the new settings, then the next frame runs. */
  const reconfigure = (next: AudioSettings) => {
    mixer.configure(next);
    mixer.update(0.016);
    backend.update(0.016);
  };
  const planned = () => ({ slots: [...backend.beds.bedSlot.subarray(0, mixer.audioSettings.buses.length)], hosts: [...backend.beds.hostBus.subarray(0, backend.beds.slotCount)], count: backend.beds.slotCount });
  return { backend, reconfigure, planned };
}

const NONE = BED_SLOT_NONE;

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
