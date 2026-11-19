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
import { voiceIndex } from "./core/ids";
import { SpatialViewFlag } from "./core/spatial";
import type { BatchWatch } from "./core/batchWatch";
import { mixer } from "../../../engine/audio/mixer";
import { closeRecordingAudio, fakeHostClock, makeFakeBackend, makeFakeClipRegistry, recordingAudio } from "./testing";
import { Op, PLAY_FLAGS_SPATIAL, readPlay } from "./wire.generated";

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
afterEach(async () => {
  vi.restoreAllMocks();
  setAudioBackend(null);
  await closeRecordingAudio();
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
    (src.reverbSendCurve[1] as [number, number])[1] = 0.25;
    frame();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.reverbSendCurve![1]![1]).toBe(0.25);
    (src.reverbSendCurve as [number, number][]).push([1, 0]);
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

// --- The core backend: the edit reaches what the passes read and what the core is sent -----------------------------------------------

/**
 * The core backend on the recording host (ADR 0234), on the page's mixer and registered; its clips are resident, an
 * ambisonic one (first order, four channels) by its name, the rest mono. `received` is what reaches the core.
 */
function useCore() {
  const clips = makeFakeClipRegistry({ info: (path) => ({ channels: path.includes("amb") ? 4 : 1 }) });
  const r = recordingAudio({ preset: { maxLogical: 16, maxWide: 2 }, clips, clock: fakeHostClock({ currentTime: 1 }) });
  return { core: r.backend, received: r.posted };
}

/** The id of the one voice playing (`debug().voices`): the source's. */
function onlyVoiceId(core: { debug(): { voices: readonly { id: number }[] } }): number {
  const voices = core.debug().voices;
  expect(voices).toHaveLength(1);
  return voices[0]!.id;
}

/** The PLAY records the backend sends from now on (decoded where the fake core receives them). */
function watchPlays(received: BatchWatch) {
  received.take();
  return () => received.pending.flatMap((b) => b.records.filter((r) => r.opcode === Op.PLAY).map((r) => readPlay(r.view, r.off)));
}

describe("AudioSource M3 fields reach the core's voice table on the next frame", () => {
  it("occlusion, dopplerLevel, reverbSend, reverbSendCurve", () => {
    const { core } = useCore();
    const src = spatialSource();
    src.play();
    frame();
    const i = voiceIndex(onlyVoiceId(core));
    // What the frame's passes read of the voice (`spatialVoices`, over the voice table).
    const t = core.spatialVoices;
    expect([!!(t.viewFlags[i]! & SpatialViewFlag.OCCLUSION), t.dopplerLevel[i], t.reverbSend[i], t.sendCurve[i]]).toEqual([true, 1, 1, 0]);

    src.occlusion = false;
    src.dopplerLevel = 3;
    src.reverbSend = 0.5;
    src.reverbSendCurve = [[0, 1], [1, 0]];
    frame();
    frame(); // the passes' list is collected before a frame's edits: it shows them on the next frame
    expect(!!(t.viewFlags[i]! & SpatialViewFlag.OCCLUSION)).toBe(false);
    expect(t.dopplerLevel[i]).toBe(3);
    expect(t.reverbSend[i]).toBe(0.5);
    expect(core.spatialVoices.curves.get(t.sendCurve[i]!)).toEqual([[0, 1], [1, 0]]);
    // The in-place edit of that curve takes another entry in the table.
    (src.reverbSendCurve[1] as [number, number])[1] = 0.5;
    frame();
    expect(core.spatialVoices.curves.get(t.sendCurve[i]!)).toEqual([[0, 1], [1, 0.5]]);
    // Back on: the flag returns; a send of 0 clears SENDS and a send above 0 sets it.
    src.occlusion = true;
    src.reverbSend = 0;
    frame();
    frame();
    expect(!!(t.viewFlags[i]! & SpatialViewFlag.OCCLUSION)).toBe(true);
    expect(!!(t.viewFlags[i]! & SpatialViewFlag.SENDS)).toBe(false);
    src.reverbSend = 1.5;
    frame();
    frame();
    expect(!!(t.viewFlags[i]! & SpatialViewFlag.SENDS)).toBe(true);
  });

  it("ambisonicYaw turns an ambisonic clip's voice", () => {
    const { core } = useCore();
    const src = spatialSource({ clip: "asset:amb.wav", ambisonicYaw: 0 });
    src.play();
    frame();
    const i = voiceIndex(onlyVoiceId(core));
    expect(core.voiceFx.yaw(i)).toBe(0);
    // The core gets the native (right-handed) yaw: the engine's +90 (right, ADR 0164) is the core's -π/2.
    src.ambisonicYaw = 90;
    frame();
    expect(core.voiceFx.yaw(i)).toBeCloseTo(-Math.PI / 2, 5);
    src.ambisonicYaw = -180;
    frame();
    expect(core.voiceFx.yaw(i)).toBeCloseTo(Math.PI, 5);
  });
});

// F-22: with its clip resident (every play after the first), the core sends a voice's PLAY inside `backend.play`, and a
// voice can't turn spatial on the core after its PLAY. A spatial source must start with its position and attenuation in
// the request, or its replays play flat while main reports them as panned (HRTF).
describe("a spatial AudioSource starts spatial on the core when its clip is resident (F-22)", () => {
  it("every PLAY carries the spatial flag, the distance gain and the direction, the replays too", () => {
    const { received } = useCore();
    const posted = watchPlays(received);
    const src = spatialSource({ minDistance: 1, maxDistance: 30 }); // 3 m to the right of the listener
    frame();
    for (let k = 0; k < 3; k++) {
      src.play();
      frame();
      src.stop();
      frame();
    }
    const plays = posted().map((a) => ({ flags: a.flags, gain: a.gain, dir: [a.dirX, a.dirY, a.dirZ] }));
    expect(plays).toHaveLength(3);
    for (const p of plays) {
      expect(p.flags & PLAY_FLAGS_SPATIAL).toBe(PLAY_FLAGS_SPATIAL);
      expect(p.gain).toBeCloseTo(1 / 3, 5); // inverse distance at 3 m from a 1 m minDistance
      expect(Math.abs(p.dir[0]!)).toBeCloseTo(1, 5); // to the side, not the flat default (0, 0, -1)
    }
  });

  it("a flat source's PLAY stays flat", () => {
    const { received } = useCore();
    const posted = watchPlays(received);
    const src = spatialSource({ spatial: false });
    src.play();
    frame();
    const flags = posted().map((a) => a.flags);
    expect(flags).toHaveLength(1);
    expect(flags[0]! & PLAY_FLAGS_SPATIAL).toBe(0);
  });

  // F-24: the core reads `spatial` from PLAY only, so a source that turns `spatial` on while playing flat stays flat on
  // the core. Main mustn't mark it spatial (pan, attenuate and report it), and says why once.
  it("turning spatial on while playing flat leaves the voice flat on main, with one warning; the next play is spatial", () => {
    const { core, received } = useCore();
    const posted = watchPlays(received);
    const warn = vi.mocked(console.warn);
    const src = spatialSource({ spatial: false });
    src.play();
    frame();
    const id = onlyVoiceId(core);
    const i = voiceIndex(id);
    src.spatial = true;
    frame();
    frame();
    expect(core.spatialVoices.viewFlags[i]! & SpatialViewFlag.SPATIAL).toBe(0);
    expect(core.debug().voices.find((v) => v.id === id)!.gain).toBeCloseTo(1, 6); // no distance gain on main for a voice the core plays flat
    expect(src.panner).toBe("flat");
    const warned = warn.mock.calls.filter((c) => String(c[0]).includes("started flat"));
    expect(warned).toHaveLength(1);
    expect(String(warned[0]![0])).toContain('"src"');
    src.stop();
    frame();
    src.play();
    frame();
    const flags = posted().map((a) => a.flags);
    expect(flags).toHaveLength(2);
    expect(flags[1]! & PLAY_FLAGS_SPATIAL).toBe(PLAY_FLAGS_SPATIAL);
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
