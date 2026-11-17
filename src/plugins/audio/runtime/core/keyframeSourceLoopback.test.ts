// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §5.5): the core backend's KEYFRAME source in a scene on the loopback
// host (the real wasm core, clip registry, shell and coreBackend). The payload `CoreBackend.keyframe` builds is compared with
// the tables it reads: the voice rows with `Audio.debug()`'s voices, the bus rows with the mixer's lanes and the slot table,
// the metered rows with the loudness hub's readings, the mix section with the mixer. Time is the loopback's rendered frames.
import { afterEach, describe, expect, it } from "vitest";
import { Lane } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { loudnessHub } from "../mix/loudnessHub";
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import { CoreBackend } from "./coreBackend";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

/** The keyframe bus row's metered flag (§5.5). */
const KF_BUS_METERED = 32;

const NO_NAME = 0xffffffff;
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

async function rig(settings: AudioSettings) {
  // ADR 0221: the production assembly on the loopback, with its own mixer.
  const audio = await loopbackAudio({ mixer: "own", settings, preset: { maxLogical: 16, maxMixed: 8 }, decode: () => ({ channelData: [new Float32Array(96_000).fill(0.25)] }), dt: 0.003 });
  if (!audio) return null;
  const { backend, mixer } = audio;
  const step = async (n: number) => {
    await audio.step(n);
  };
  /** The sink's interning, as a map the test can read back. */
  const interned = new Map<string, number>();
  const nameId = (table: string, name: string): number => {
    const key = `${table}:${name}`;
    if (!interned.has(key)) interned.set(key, interned.size + 1);
    return interned.get(key)!;
  };
  const nameOf = (table: string, id: number): string | undefined => [...interned].find(([k, v]) => v === id && k.startsWith(`${table}:`))?.[0].slice(table.length + 1);
  return { backend, mixer, step, nameId, nameOf };
}

const settingsWith = (patch: (s: AudioSettings) => void): AudioSettings => {
  const s = defaultAudioSettings();
  patch(s);
  return s;
};

afterEach(closeLoopbackAudio);

describe("CoreBackend.keyframe on the loopback host", () => {
  it("voice rows equal the voice table (Audio.debug()'s rows): id, clip, bus slot, state, priority, gain, pitch, audibility, playhead", async (ctx) => {
    const r = await rig(defaultAudioSettings());
    if (!r) return ctx.skip();
    const a = r.backend.play(req("a.wav", { priority: 50, volume: 0.5 }))!;
    const b = r.backend.play(req("b.wav", { priority: 200, bus: "Music", volume: 0.25, pitch: 2 }))!;
    const c = r.backend.play(req("c.wav", { priority: 10, loop: false }))!;
    await r.step(12);
    await r.step(6);
    const kf = r.backend.keyframe(r.nameId, NO_NAME);
    const debug = r.backend.debug();
    const live = debug.voices.filter((v) => v.state !== "stolen");
    expect(live.length).toBeGreaterThanOrEqual(3);
    const stateCode = { playing: 0, virtual: 1, stolen: 2, waitingForData: 3, busMuted: 4, locked: 5 } as const; // §5.5
    expect(kf.voices).toHaveLength(debug.voices.length);
    for (const v of debug.voices) {
      const row = kf.voices.find((x) => x.id === v.id);
      expect(row, `voice ${v.id}`).toBeDefined();
      expect(r.nameOf("clips", row!.clip) ?? "").toBe(v.clip);
      expect(row!.slot).toBe(debug.buses.findIndex((x) => x.name === v.bus));
      expect(row!.state).toBe(stateCode[v.state]);
      expect(row!.priority).toBe(v.priority);
      expect(row!.gain).toBe(Math.fround(v.gain));
      expect(row!.pitch).toBe(Math.min(0xffff, Math.round(v.pitch * 4096)));
      expect(row!.audibility).toBe(Math.min(0xffff, Math.round(v.audibility * 65536)));
      const clipRate = 48_000;
      if (v.playheadSeconds !== null) expect(row!.playheadFrames / clipRate).toBeCloseTo(v.playheadSeconds, 3);
    }
    // The clip names the voices carry were interned through the callback, once each.
    expect(r.nameOf("clips", kf.voices.find((x) => x.id === a.id)!.clip)).toBe("a.wav");
    expect(kf.voices.find((x) => x.id === b.id)!.slot).toBe(debug.buses.findIndex((x) => x.name === "Music"));
    expect(kf.voices.find((x) => x.id === b.id)!.pitch).toBe(8192);
    expect(kf.voices.some((x) => x.id === c.id)).toBe(true);
    r.backend.dispose();
  });

  it("bus rows equal the mixer's lanes: value and target of authored, runtime, snapshot, monitor and dip, duck and automation, the gates and the metered flag", async (ctx) => {
    const settings = settingsWith((s) => {
      s.buses = s.buses.map((b) => (b.name === "SFX" ? { ...b, meter: "loudness" as const } : b));
      s.snapshots = [{ name: "Hush", volumes: { Music: 0.3, SFX: 0.6 }, lowpass: {} }];
    });
    const r = await rig(settings);
    if (!r) return ctx.skip();
    r.backend.play(req("a.wav"));
    r.mixer.bus("Music").volume = 0.5; // runtime lane
    r.mixer.bus("Voice").fadeTo(0.25, 5); // a running fade: the value is mid-ramp, the target is the end
    r.mixer.snapshot("Hush", 0); // snapshot lane
    r.mixer.setMonitor("SFX", { solo: true }); // monitor lane: the others read 0
    await r.step(16);
    const kf = r.backend.keyframe(r.nameId, NO_NAME);
    const slots = r.backend.buses.slots.slots;
    const live = slots.map((s, i) => ({ s, i })).filter((x) => x.s.state === "live");
    expect(kf.buses.map((b) => b.slot)).toEqual(live.map((x) => x.i));
    for (const { s, i } of live) {
      const row = kf.buses.find((x) => x.slot === i)!;
      const name = s.name!;
      const lanes = r.mixer._lanes(name)!;
      const L = row.lanes;
      expect(L).toHaveLength(10);
      const pair = (k: number, lane: 0 | 1 | 2 | 3 | 4) => [L[2 * k], L[2 * k + 1]] as const;
      expect(pair(0, Lane.authored)[0]).toBe(Math.fround(r.mixer.laneGain(name, Lane.authored)));
      expect(pair(0, Lane.authored)[1]).toBe(Math.fround(lanes.authoredMute ? 0 : lanes.authored.to));
      expect(pair(1, Lane.runtime)[0]).toBe(Math.fround(r.mixer.laneGain(name, Lane.runtime)));
      expect(pair(1, Lane.runtime)[1]).toBe(Math.fround(lanes.runtimeMute ? 0 : lanes.runtime.to));
      expect(pair(2, Lane.snapshot)[0]).toBe(Math.fround(r.mixer.laneGain(name, Lane.snapshot)));
      expect(pair(2, Lane.snapshot)[1]).toBe(Math.fround(lanes.snapshot.to));
      expect(pair(3, Lane.monitor)[0]).toBe(Math.fround(r.mixer.laneGain(name, Lane.monitor)));
      expect(pair(4, Lane.dip)[0]).toBe(Math.fround(r.mixer.laneGain(name, Lane.dip)));
      expect(pair(4, Lane.dip)[1]).toBe(Math.fround(lanes.dip.to));
      expect(row.duck).toBe(Math.fround(r.mixer.laneGain(name, Lane.duck)));
      expect(row.automation).toBe(Math.fround(r.mixer.laneGain(name, Lane.automation)));
      expect(row.gen).toBe(s.gen);
    }
    // The scene did move lanes (not all unity): the snapshot lane of Music, the runtime lane of Music, the monitor lane of Music (solo elsewhere).
    const row = (name: string) => kf.buses.find((x) => x.slot === slots.findIndex((s) => s.name === name))!;
    expect(row("Music").lanes[4]).toBeCloseTo(0.3, 5); // snapshot value
    expect(row("Music").lanes[2]).toBeCloseTo(0.5, 5); // runtime value
    expect(row("Music").lanes[6]).toBe(0); // monitor: silenced by SFX's solo
    expect(row("Voice").lanes[3]).toBeCloseTo(0.25, 5); // the fade's target
    expect(row("Voice").lanes[2]).toBeGreaterThan(0.25); // its value is still on the way
    expect(row("SFX").flags & 8).toBe(8); // monitor solo
    expect(row("SFX").flags & KF_BUS_METERED).toBe(KF_BUS_METERED);
    expect(row("Music").flags & KF_BUS_METERED).toBe(0);
    expect(kf.mix.monitorActive).toBe(1);
    expect(kf.mix.snapshotName).toBe(r.nameId("snapshots", "Hush"));
    r.backend.dispose();
  });

  it("metered rows: the output first (LOUD_OUTPUT_TAP), then the metered buses, with the hub's readings; the mix section's target and master", async (ctx) => {
    const settings = settingsWith((s) => {
      s.buses = s.buses.map((b) => (b.name === "SFX" ? { ...b, meter: "loudness" as const } : b));
    });
    const r = await rig(settings);
    if (!r) return ctx.skip();
    r.backend.masterVolume = 0.5;
    r.backend.play(req("a.wav"));
    await r.step(80); // a second or two of audio through the meters
    const kf = r.backend.keyframe(r.nameId, NO_NAME);
    const sfxSlot = r.backend.buses.slots.slots.findIndex((s) => s.name === "SFX");
    expect(kf.metered.map((m) => m.slot)).toEqual([LOUD_OUTPUT_TAP, sfxSlot]);
    for (const m of kf.metered) {
      const name = m.slot === LOUD_OUTPUT_TAP ? settings.buses[0]!.name : "SFX";
      const hub = loudnessHub.busLoudness(name)!;
      expect(m.momentary).toBe(Math.fround(hub.momentary));
      expect(m.shortTerm).toBe(Math.fround(hub.shortTerm));
      expect(m.integrated).toBe(Math.fround(hub.integrated));
      expect(m.maxTruePeak).toBe(Math.fround(hub.maxTruePeak));
      expect(m.elapsed).toBe(Math.fround(hub.elapsed));
    }
    expect(kf.metered[0]!.elapsed).toBeGreaterThan(0); // the meters ran
    expect(kf.mix.masterVolume).toBe(0.5);
    expect(kf.mix.hiddenMute).toBe(0);
    expect(kf.mix.slotTableVersion).toBe(r.backend.buses.slots.version);
    r.backend.dispose();
  });

  it("rows are reused from one call to the next, and a voice that ended is gone from the next payload", async (ctx) => {
    const r = await rig(defaultAudioSettings());
    if (!r) return ctx.skip();
    const a = r.backend.play(req("a.wav", { loop: false }))!;
    await r.step(6);
    const first = r.backend.keyframe(r.nameId, NO_NAME);
    const row = first.voices[0]!;
    expect(first.voices.map((v) => v.id)).toContain(a.id);
    await r.step(220); // 96,000 frames at 512 per step: it ends
    const second = r.backend.keyframe(r.nameId, NO_NAME);
    expect(second).toBe(first);
    expect(second.voices.find((v) => v.id === a.id)).toBeUndefined();
    expect(second.voices).toHaveLength(0);
    expect(row).toBeDefined();
    r.backend.dispose();
  });
});
