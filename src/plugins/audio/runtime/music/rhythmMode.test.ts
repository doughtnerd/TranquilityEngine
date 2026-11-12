// ADR 0166 Rh1 (api-and-models §1.3, §1.5; architecture §4.6): `Audio.latency` and `Audio.rhythmMode`
// (`calibration.ts` `audioLatency`, `rhythmModeSetting`) on the fake backend, and the hold of beat callbacks through a
// recovery (`background.ts` `updateBeatHolds`, the flag K1's `predictDue` honours). The loopback half is
// `core/rhythmModeLoopback.test.ts`.
import { afterEach, describe, expect, it } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { EventInstance } from "../events/eventRuntime";
import { setAudioBackend, type AudioBackend } from "../backend";
import { makeFakeBackend } from "../testing";
import { Audio } from "../Audio";
import { audioLatency, rhythmModeSetting } from "./calibration";
import { _resetMusicPlayers, createMusicPlayer, type MusicPlayer } from "./musicSystem";
import { _resetMusicBackground, recoverGroups, updateBeatHolds } from "./background";
import { createBeatState } from "./beatClock";
import type { SegmentRun } from "./segmentRun";

const pageSettings = mixer.audioSettings;
afterEach(() => {
  mixer.configure(pageSettings);
  _resetMusicPlayers();
  _resetMusicBackground();
});

const rhythm = (on: boolean) => mixer.configure({ ...defaultAudioSettings(), rhythmMode: on });

describe("Audio.latency (audioLatency)", () => {
  it("is the backend's figures, sanitised, with the total recomputed", () => {
    const b = makeFakeBackend();
    setAudioBackend(b);
    b.latencyValue = { base: 0.0029, output: 0.008, limiter: 0.0015, total: 99, reliable: true };
    const l = Audio.latency;
    expect(l).toEqual({ base: 0.0029, output: 0.008, limiter: 0.0015, total: 0.0029 + 0.008 + 0.0015, reliable: true });
    expect(Audio.latency).not.toBe(l); // a new object per read
    b.latencyValue = { base: Number.NaN, output: -0.01, limiter: Number.POSITIVE_INFINITY, total: 0, reliable: true };
    expect(audioLatency()).toEqual({ base: 0, output: 0, limiter: 0, total: 0, reliable: false });
  });

  it("reliable needs the backend's verdict and 0 < output < 0.5 (S13)", () => {
    const b = makeFakeBackend();
    setAudioBackend(b);
    b.latencyValue = { base: 0.01, output: 0.032, limiter: 0.0015, total: 0, reliable: false };
    expect(audioLatency().reliable).toBe(false); // the core's rule: no evidence the figure is live
    b.latencyValue = { ...b.latencyValue, reliable: true, output: 0.5 };
    expect(audioLatency().reliable).toBe(false);
    b.latencyValue = { ...b.latencyValue, output: 0 };
    expect(audioLatency().reliable).toBe(false);
    b.latencyValue = { ...b.latencyValue, output: 0.4999 };
    expect(audioLatency().reliable).toBe(true);
  });

  it("a backend without latency() (the Babylon fallback) reads zeros, not reliable", () => {
    const b = makeFakeBackend() as unknown as { latency?: unknown };
    delete b.latency;
    setAudioBackend(b as unknown as AudioBackend);
    expect(audioLatency()).toEqual({ base: 0, output: 0, limiter: 0, total: 0, reliable: false });
  });
});

describe("Audio.rhythmMode (rhythmModeSetting)", () => {
  it("is the project setting the mixer runs with", () => {
    setAudioBackend(makeFakeBackend());
    rhythm(false);
    expect(Audio.rhythmMode).toBe(false);
    rhythm(true);
    expect(Audio.rhythmMode).toBe(true);
    expect(rhythmModeSetting()).toBe(true);
  });
});

describe("holding beat callbacks through a recovery (updateBeatHolds, architecture §4.6)", () => {
  function segment(): SegmentNode {
    const node = parseSegmentNode({ type: "segment", id: "s", gridOffset: 0, tracks: [{ name: "t", clip: "music/a.ogg" }] }, "test", newMusicContext());
    if (!node) throw new Error("fixture segment did not parse");
    return node;
  }
  let group = 3;
  function player(): MusicPlayer {
    const p = createMusicPlayer({ group: group++, world: 1, path: "m.audioevent", asset: { bus: "Music", volume: 1 } } as unknown as EventInstance, segment());
    p.beats = createBeatState();
    p.run = { node: segment() } as unknown as SegmentRun;
    p.state = "playing";
    return p;
  }
  /** A backend view: `caps.rhythm` (the core: true; Babylon: false) and the core backend's `isRecovering`. */
  const backend = (caps: boolean, recovering: boolean) =>
    ({ music: { caps: { primes: true, stampedFades: true, heardClock: true, rhythm: caps } }, isRecovering: recovering }) as unknown as AudioBackend;

  it("in rhythm mode: held while the backend rebuilds, until re-planned and stamped", () => {
    rhythm(true);
    const p = player();
    const idle = player();
    idle.run = null; // nothing playing: nothing to recover
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(false);
    updateBeatHolds(backend(true, true));
    expect(p.beats!.held).toBe(true);
    expect(idle.beats!.held).toBe(true); // nothing fires during a rebuild
    // The new core answered, but the players haven't been re-planned yet: still held (not the idle one).
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(true);
    expect(idle.beats!.held).toBe(false);
    // Re-planned: its own state holds it until the stamp (`recoverPlayer` sets `recovering`, the stamp `committed`).
    p.state = "stopping"; // recoverPlayer skips a stopping player: only the awaiting mark goes
    recoverGroups(backend(true, false), "rebuild");
    p.state = "recovering";
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(true);
    p.state = "committed";
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(false);
  });

  it("an abandon or crash recovery holds too, while the re-entry is unstamped", () => {
    rhythm(true);
    const p = player();
    p.state = "recovering";
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(true);
  });

  it("outside rhythm mode, or on a backend without rhythm support, nothing is held (and an old hold is released)", () => {
    rhythm(false);
    const p = player();
    updateBeatHolds(backend(true, true));
    expect(p.beats!.held).toBe(false);
    p.state = "recovering";
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(false);
    rhythm(true);
    updateBeatHolds(backend(false, false));
    expect(p.beats!.held).toBe(false);
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(true);
    rhythm(false);
    updateBeatHolds(backend(true, false));
    expect(p.beats!.held).toBe(false);
  });

  it("a player not yet predicted (no beat state) is left alone", () => {
    rhythm(true);
    const p = player();
    p.beats = null;
    updateBeatHolds(backend(true, true));
    expect(p.beats).toBeNull();
  });
});
