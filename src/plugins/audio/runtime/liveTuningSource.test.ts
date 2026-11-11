// ADR 0162 E7 (#158): live tuning of the AudioSource M3 fields and the AudioListener velocity override. Every field is
// edited on a playing source, and the change must reach the backend on the next audio frame: first as the
// `setSpatialOptions` call a backend voice receives (a fake voice that records it), then in the core backend's voice
// table (the values the passes read the following frame). The audio system runs as the engine runs it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import type { World } from "../../../engine/core/World";
import { setAudioBackend, type VoiceSpatialOptions } from "./backend";
import { AUDIO_SYSTEMS } from "./audioSystem";
import { AudioListener } from "./AudioListener";
import { AudioSource } from "./AudioSource";
import { CoreLink, type AudioHost, type HostLifecycleListener, type LinkPort } from "./core/context";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import type { ClipInfo, ClipRegistry, ClipResidentListener, ClipState } from "./core/clipRegistry";
import { voiceIndex } from "./core/ids";
import { VoiceFlag2 } from "./core/voiceTable";
import { mixer } from "../../../engine/audio/mixer";
import { makeFakeBackend } from "./testing";

let world: World;
const system = AUDIO_SYSTEMS[0]!;
/** One engine frame of the audio system (it calls `_sync` on every source). */
const frame = (): void => system.run(world, 0.016);

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", nodes: [] },
      "a.wav": "data:audio/wav;base64,AAAA",
      "amb.wav": "data:audio/wav;base64,AAAA",
      "amb.wav.meta.json": { format: "myco.import@1", ambisonic: { convention: "ambix" } },
    }),
  );
  const engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  world = engine.world;
});
afterEach(() => {
  vi.restoreAllMocks();
  setAudioBackend(null);
});

const spatialSource = (fields: Record<string, unknown> = {}): AudioSource => {
  const node = GameObject.create("src");
  node.transform!.position = [3, 0, 0];
  return node.addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false, spatial: true, ...fields });
};

describe("AudioSource M3 fields reach a backend voice on the next frame (fake backend)", () => {
  /** A fake backend whose voices take Play edits the way the core's do, recording each call. */
  function useFake() {
    const fake = makeFakeBackend();
    const edits: VoiceSpatialOptions[] = [];
    const play = fake.play.bind(fake);
    fake.play = (req) => Object.assign(play(req)!, { setSpatialOptions: (o: VoiceSpatialOptions) => edits.push(o) });
    setAudioBackend(fake);
    return { fake, edits };
  }

  it.each<[string, unknown, VoiceSpatialOptions]>([
    ["occlusion", false, { occlusion: false }],
    ["dopplerLevel", 2.5, { dopplerLevel: 2.5 }],
    ["reverbSend", 0.4, { reverbSend: 0.4 }],
    ["ambisonicYaw", 45, { yaw: 45 }],
  ])("%s: a Play edit is one setSpatialOptions with the clamped value, once", (field, value, expected) => {
    const { edits } = useFake();
    const src = spatialSource();
    src.play();
    frame();
    expect(edits).toHaveLength(0); // the play request carried the initial values
    (src as unknown as Record<string, unknown>)[field] = value;
    frame();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject(expected);
    frame();
    expect(edits).toHaveLength(1); // nothing changed: nothing sent
  });

  it("values past the range are clamped on the way to the backend", () => {
    const { edits } = useFake();
    const src = spatialSource();
    src.play();
    frame();
    src.dopplerLevel = 99;
    src.reverbSend = -1;
    src.ambisonicYaw = 720;
    frame();
    expect(edits.at(-1)).toMatchObject({ dopplerLevel: 5, reverbSend: 0, yaw: 180 });
  });

  it("reverbSendCurve: replacing the curve reaches the voice", () => {
    const { edits } = useFake();
    const src = spatialSource();
    src.play();
    frame();
    src.reverbSendCurve = [[0, 1], [1, 0]];
    frame();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.reverbSendCurve).toEqual([[0, 1], [1, 0]]);
  });

  it("reverbSendCurve: editing a point of the curve in place reaches the voice too", () => {
    const { edits } = useFake();
    const src = spatialSource();
    src.play();
    frame();
    src.reverbSendCurve[1]![1] = 0.25;
    frame();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.reverbSendCurve![1]![1]).toBe(0.25);
    src.reverbSendCurve.push([1, 0]);
    frame();
    expect(edits).toHaveLength(2);
    frame();
    expect(edits).toHaveLength(2);
  });

  it("an ambisonic clip's yaw reaches the voice on the next frame", () => {
    const { fake, edits } = useFake();
    const src = spatialSource({ clip: "asset:amb.wav" });
    src.play();
    expect(fake.plays.at(-1)!.ambisonic).toBe(true);
    frame();
    src.ambisonicYaw = -90;
    frame();
    expect(edits).toEqual([expect.objectContaining({ yaw: -90 })]);
  });

  it("the older fields still apply next frame: volume, pitch, priority, distances", () => {
    const { fake } = useFake();
    const src = spatialSource();
    src.play();
    frame();
    const v = fake.voices.at(-1)!;
    src.volume = 0.5;
    src.pitch = 2;
    src.priority = 7;
    src.maxDistance = 40;
    frame();
    expect([v.volume, v.pitch]).toEqual([0.5, 2]);
    expect(v.attenuation).toMatchObject({ maxDistance: 40 });
    expect(v.events.some((e) => e.kind === "priority" && e.value === 7)).toBe(true);
  });

  it("a clip's options are read at each play: a stop and play after an edit carries the new values", () => {
    const { fake } = useFake();
    const src = spatialSource({ reverbSend: 0.3, occlusion: false });
    src.play();
    expect(fake.plays.at(-1)).toMatchObject({ occlusion: false, reverbSend: 0.3 });
    src.stop();
    src.reverbSend = 0.9;
    src.play();
    expect(fake.plays.at(-1)).toMatchObject({ reverbSend: 0.9 });
  });
});

// --- The core backend: the edit lands in the voice table the passes read -----------------------------------------------

class Registry implements ClipRegistry {
  private ids = new Map<string, number>();
  acquire(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) this.ids.set(path, (id = this.ids.size + 1));
    return id;
  }
  release(): void {}
  state(): ClipState {
    return "ready";
  }
  info(id: number): ClipInfo | null {
    return { id, path: "", state: "ready", refs: 1, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null };
  }
  onResident(_id: number, _l: ClipResidentListener): () => void {
    return () => {};
  }
  releaseWorld(): void {}
  acquireReserved(): void {}
  applyClipEvent(): void {}
  residentIds(): readonly number[] {
    return [];
  }
}

function useCore() {
  const port: LinkPort = { onmessage: null, postMessage: () => {} };
  const link = new CoreLink(port);
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxWide: 2 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((_l: HostLifecycleListener) => () => {}) as AudioHost["addLifecycleListener"],
  };
  const t = 1000;
  const clock = {
    rafTime: () => t,
    outputTimestamp: () => ({ contextTime: t / 1000, performanceTime: t }),
    currentTime: () => t / 1000,
    dateNow: () => 1_000_000 + t,
    fake: true as const,
  };
  const backend = new CoreBackend(host, { clips: new Registry(), clock, mixer });
  setAudioBackend(backend);
  return backend;
}

describe("AudioSource M3 fields reach the core's voice table on the next frame", () => {
  it("occlusion, dopplerLevel, reverbSend, reverbSendCurve", () => {
    const core = useCore();
    const src = spatialSource();
    src.play();
    frame();
    const i = voiceIndex(src._voiceId);
    const t = core.table;
    expect([!!(t.flags2[i]! & VoiceFlag2.OCCLUSION), t.dopplerLevel[i], t.reverbSend[i], t.sendCurve[i]]).toEqual([true, 1, 1, 0]);

    src.occlusion = false;
    src.dopplerLevel = 3;
    src.reverbSend = 0.5;
    src.reverbSendCurve = [[0, 1], [1, 0]];
    frame();
    expect(!!(t.flags2[i]! & VoiceFlag2.OCCLUSION)).toBe(false);
    expect(t.dopplerLevel[i]).toBe(3);
    expect(t.reverbSend[i]).toBe(0.5);
    expect(core.spatialVoices.curves.get(t.sendCurve[i]!)).toEqual([[0, 1], [1, 0]]);
    // The in-place edit of that curve takes another entry in the table.
    src.reverbSendCurve[1]![1] = 0.5;
    frame();
    expect(core.spatialVoices.curves.get(t.sendCurve[i]!)).toEqual([[0, 1], [1, 0.5]]);
    // Back on: the flag returns; a send of 0 clears SENDS and a send above 0 sets it.
    src.occlusion = true;
    src.reverbSend = 0;
    frame();
    expect(!!(t.flags2[i]! & VoiceFlag2.OCCLUSION)).toBe(true);
    expect(!!(t.flags2[i]! & VoiceFlag2.SENDS)).toBe(false);
    src.reverbSend = 1.5;
    frame();
    expect(!!(t.flags2[i]! & VoiceFlag2.SENDS)).toBe(true);
  });

  it("ambisonicYaw turns an ambisonic clip's voice", () => {
    const core = useCore();
    const src = spatialSource({ clip: "asset:amb.wav", ambisonicYaw: 0 });
    src.play();
    frame();
    const i = voiceIndex(src._voiceId);
    expect(core.table.yaw[i]).toBe(0);
    src.ambisonicYaw = 90;
    frame();
    expect(core.table.yaw[i]).toBeCloseTo(Math.PI / 2, 5);
    src.ambisonicYaw = -180;
    frame();
    expect(core.table.yaw[i]).toBeCloseTo(-Math.PI, 5);
  });
});

describe("AudioListener velocity override", () => {
  it("setVelocity is the Doppler pass's listener velocity on the next frame; null returns to the estimate", () => {
    useCore();
    const listener = GameObject.create("ears").addBehavior(AudioListener);
    const src = spatialSource();
    src.play();
    frame();
    expect(listener.velocity.x).toBe(0);
    // The frame writes the velocity it used back through `_noteVelocity` (the estimate field); the override shows until cleared.
    listener.setVelocity({ x: 5, y: 0, z: 0 });
    expect(listener.velocity.x).toBe(5);
    frame();
    listener.setVelocity(null);
    expect(listener.velocity.x).toBe(5); // what the last frame used was the override
    for (let k = 0; k < 40; k++) frame();
    expect(Math.abs(listener.velocity.x)).toBeLessThan(0.01); // estimating again (smoothed): the node hasn't moved
    // A new value replaces the old one on the next frame.
    listener.setVelocity({ x: 0, y: 7, z: 0 });
    frame();
    listener.setVelocity(null);
    expect(listener.velocity.y).toBe(7);
  });
});
