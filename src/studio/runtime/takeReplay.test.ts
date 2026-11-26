// ADR 0348 "Replay": the replay model, through its interface, over a fake clock and a target that records what it is
// asked: requests at their times and in order, seek reconstruction from the nearest keyframe, pose interpolation, the
// loop range and Restart instances.
import { describe, expect, it } from "vitest";
import { Take } from "../../engine/audio/take/reader";
import type { TakeRecord } from "../../engine/audio/take/records";
import type { TakeMeta, TakeRequest } from "../../engine/audio/take/types";
import { TakeReplay, UNSEEDED_NOTE, type ReplayHandle, type ReplayLineHandle, type ReplayPlayOptions, type ReplayPose, type ReplayTarget, type Vec3 } from "./takeReplay";

const META: TakeMeta = { project: "P", engine: "myco", audioHash: "h", seed: 9, device: "ua", started: new Date(0).toISOString(), duration: 10, emitters: { 0: "Listener", 1: "Bike" }, frames: false };
const req = (q: TakeRequest): TakeRecord => ({ type: "request", requests: [q] });
const v = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });

interface FakeHandle extends ReplayHandle {
  readonly id: number;
  readonly path: string;
  readonly options: ReplayPlayOptions;
  stopped: number | null;
  released: boolean;
  params: Record<string, number>;
  triggers: string[];
}

function fakeTarget(opts: { seeds?: boolean } = {}) {
  const log: string[] = [];
  const handles: FakeHandle[] = [];
  const poses: ReplayPose[] = [];
  let master = 1;
  let next = 0;
  const target: ReplayTarget = {
    play(path, options) {
      const h: FakeHandle = {
        id: next++, path, options, stopped: null, released: false, params: { ...options.parameters }, triggers: [], position: options.position ?? null,
        get playing() { return h.stopped === null; },
        stop(f = 0) { if (h.stopped === null) { h.stopped = f; log.push(`stop ${path}`); } },
        release() { h.released = true; log.push(`release ${path}`); },
        setParameter(n, value) { h.params[n] = value; log.push(`param ${path} ${n}=${value}`); },
        trigger(n) { h.triggers.push(n); log.push(`trigger ${path} ${n}`); },
        pause() { log.push(`pause ${path}`); },
        resume() { log.push(`resume ${path}`); },
        fade(to, s) { log.push(`fade ${path} ${to}/${s}`); },
      };
      handles.push(h);
      log.push(`play ${path}`);
      return h;
    },
    setGlobal: (n, value) => log.push(`global ${n}=${value}`),
    busVolume: (b, value, s) => log.push(`bus ${b}=${value}/${s}`),
    snapshot: (n, s) => log.push(`snapshot ${n}/${s}`),
    clearSnapshot: (s) => log.push(`clear/${s}`),
    masterVolume(value) {
      if (value !== undefined) { master = value; log.push(`master ${value}`); }
      return master;
    },
    listener: (p) => poses.push(p),
    seed: (s) => (log.push(`seed ${s}`), opts.seeds ?? true),
  };
  return { target, log, handles, poses, alive: () => handles.filter((h) => h.playing) };
}

function setup(records: TakeRecord[], meta: TakeMeta = META, opts?: { seeds?: boolean }) {
  const clock = { t: 100 };
  const fake = fakeTarget(opts);
  const replay = new TakeReplay(new Take(meta, records), fake.target, { now: () => clock.t });
  const at = (t: number) => {
    clock.t = 100 + t;
    replay.tick();
  };
  return { replay, clock, at, ...fake };
}

describe("TakeReplay (ADR 0348)", () => {
  it("issues each request when the playhead passes it, in file order among equal times", () => {
    const { replay, log, at, handles } = setup([
      req({ kind: "param", t: 0, instance: null, name: "Speed", value: 10 }),
      req({ kind: "play", t: 0.5, instance: 1, path: "engine", emitter: null, options: { volume: 0.5, parameters: { Rpm: 900 } } }),
      req({ kind: "param", t: 1, instance: 1, name: "Rpm", value: 3000 }),
      req({ kind: "trigger", t: 1.5, instance: 1, name: "Hit" }),
      req({ kind: "mix", t: 2, op: "busFade", target: "Music", value: 0.25, seconds: 1 }),
      req({ kind: "release", t: 3, instance: 1 }),
      req({ kind: "stop", t: 4, instance: 1, fade: 0.2 }),
      req({ kind: "play", t: 4, instance: 1, path: "brake", emitter: null, options: {} }),
      req({ kind: "mark", t: 4.5, text: "here" }),
    ]);
    replay.play();
    expect(log).toEqual(["bus Music=1/0", "seed 9"]); // a bus the take sets starts from its plain level
    log.length = 0;
    at(0.6);
    expect(log).toEqual(["global Speed=10", "play engine"]);
    expect(handles[0]!.options).toMatchObject({ volume: 0.5, parameters: { Rpm: 900 } });
    at(5);
    expect(log.slice(2)).toEqual(["param engine Rpm=3000", "trigger engine Hit", "bus Music=0.25/1", "release engine", "stop engine", "play brake"]);
    expect(handles[0]!.stopped).toBe(0.2);
    expect(replay.time.value).toBe(5);
    expect(replay.instances.value.map((i) => i.path)).toEqual(["brake"]);
  });

  it("ADR 0386: re-issues a handle's pause, resume and fade at their times", () => {
    const { replay, log, at } = setup([
      req({ kind: "play", t: 0.5, instance: 1, path: "music", emitter: null, options: {} }),
      req({ kind: "pause", t: 1, instance: 1 }),
      req({ kind: "pause", t: 1.2, instance: 1 }), // already paused: nothing
      req({ kind: "resume", t: 2, instance: 1 }),
      req({ kind: "fade", t: 3, instance: 1, to: 0.5, seconds: 2 }),
    ]);
    replay.play();
    log.length = 0;
    at(4);
    expect(log).toEqual(["play music", "pause music", "resume music", "fade music 0.5/2"]);
  });

  it("ADR 0386: a seek starts an instance where its pauses left it, paused if it was, at its fade gain with the rest of its fade", () => {
    const records = [
      req({ kind: "play", t: 0, instance: 1, path: "music", emitter: null, options: {} }),
      req({ kind: "pause", t: 1, instance: 1 }),
      req({ kind: "resume", t: 3, instance: 1 }),
      req({ kind: "fade", t: 4, instance: 1, to: 0, seconds: 2 }),
      req({ kind: "pause", t: 6, instance: 1 }),
    ];
    const a = setup(records);
    a.replay.play();
    a.replay.seek(5);
    const h = a.alive()[0]!;
    // 5 s into the take, 2 of them paused: 3 s into the music; halfway down a 1 -> 0 fade with 1 s of it left.
    expect(h.options.offset).toBeCloseTo(3, 9);
    expect(a.log.slice(-2)).toEqual(["fade music 0.5/0", "fade music 0/1"]);
    const b = setup(records);
    b.replay.play();
    b.replay.seek(2);
    // Paused at 1 (1 s in): it starts there, paused, and the resume at 3 is still to come.
    expect(b.alive()[0]!.options.offset).toBeCloseTo(1, 9);
    expect(b.log.at(-1)).toBe("pause music");
    b.log.length = 0;
    b.at(1.5);
    expect(b.log).toEqual(["resume music"]);
  });

  it("stops at the end of the take and plays again from the start", () => {
    const { replay, at, alive, log } = setup([req({ kind: "play", t: 1, instance: 1, path: "a", emitter: null, options: {} })]);
    replay.play();
    at(12);
    expect(replay.playing.value).toBe(false);
    expect(replay.time.value).toBe(10);
    expect(alive()).toHaveLength(0);
    log.length = 0;
    replay.play();
    expect(replay.time.value).toBe(0);
    expect(log).toEqual(["seed 9"]);
  });

  it("pauses (sounds stop, the playhead stays) and resumes from there", () => {
    const { replay, at, alive, clock } = setup([req({ kind: "play", t: 1, instance: 1, path: "a", emitter: null, options: {} })]);
    replay.play();
    at(2);
    expect(alive()).toHaveLength(1);
    replay.pause();
    expect(alive()).toHaveLength(0);
    clock.t += 50;
    replay.tick();
    expect(replay.time.value).toBe(2);
    replay.play();
    expect(alive().map((h) => h.path)).toEqual(["a"]);
    expect(alive()[0]!.options.offset).toBeCloseTo(1, 9); // it started at 1: resumed 1 s in at 2
    expect(replay.note.value).toBeNull();
  });

  it("seeks from the nearest keyframe: its instances and globals, then the requests up to the seek time", () => {
    const { replay, log, alive } = setup([
      { type: "keyframe", keyframe: { t: 0, instances: [], globals: { Surface: 0 } } },
      req({ kind: "play", t: 0.5, instance: 1, path: "engine", emitter: null, options: { bus: "Vehicles", parameters: { Rpm: 900 } } }),
      req({ kind: "play", t: 0.7, instance: 2, path: "wind", emitter: null, options: {} }),
      { type: "keyframe", keyframe: { t: 1, instances: [{ instance: 1, path: "engine", started: 0.5, emitter: null, parameters: { Rpm: 1500 } }, { instance: 2, path: "wind", started: 0.7, emitter: null, parameters: {} }], globals: { Surface: 1 } } },
      req({ kind: "param", t: 1.2, instance: 1, name: "Rpm", value: 4000 }),
      req({ kind: "release", t: 1.3, instance: 1 }),
      req({ kind: "stop", t: 1.4, instance: 2, fade: 0 }),
      req({ kind: "param", t: 1.5, instance: null, name: "Surface", value: 2 }),
      req({ kind: "play", t: 1.6, instance: 3, path: "boost", emitter: null, options: {} }),
      req({ kind: "mix", t: 0.2, op: "snapshotStart", target: "Pause", value: 1, seconds: 2 }),
      req({ kind: "mix", t: 0.3, op: "busVolume", target: "Music", value: 0.5, seconds: 0 }),
      req({ kind: "play", t: 1.8, instance: 4, path: "later", emitter: null, options: {} }),
    ]);
    replay.play();
    replay.seek(1.7);
    const started = alive();
    expect(started.map((h) => h.path).sort()).toEqual(["boost", "engine"]);
    const engine = started.find((h) => h.path === "engine")!;
    expect(engine.options).toMatchObject({ bus: "Vehicles", parameters: { Rpm: 4000 } }); // options from its PLAY, parameters as at 1.7
    expect(engine.released).toBe(true);
    expect(log).toContain("global Surface=2");
    expect(log.find((l) => l.startsWith("snapshot Pause/"))!.slice(15)).toMatch(/^0\.5/); // what is left of its fade
    expect(log).toContain("bus Music=0.5/0");
    expect(engine.options.offset).toBeCloseTo(1.2, 9); // started at 0.5, so 1.2 s in at 1.7
    expect(started.find((h) => h.path === "boost")!.options.offset).toBeCloseTo(0.1, 9);
    expect(replay.note.value).toBeNull();
    expect(replay.instances.value.map((i) => i.instance)).toEqual([1, 3]);
    // Requests at and after the seek time are still to come.
    expect(log).not.toContain("play later");
  });

  it("doesn't start a keyframe instance twice when its PLAY is at the keyframe's time", () => {
    const { replay, alive, at } = setup([
      { type: "keyframe", keyframe: { t: 0, instances: [{ instance: 1, path: "a", started: 0, emitter: null, parameters: {} }], globals: {} } },
      req({ kind: "play", t: 0, instance: 1, path: "a", emitter: null, options: {} }),
    ]);
    replay.play();
    at(0.5);
    expect(alive()).toHaveLength(1);
  });

  it("interpolates poses, holding across a gap until one frame before the next pose", () => {
    const { replay, at, handles, poses } = setup([
      req({ kind: "pose", t: 0, emitter: 0, position: v(0), velocity: v(0), forward: v(0, 0, 1) }),
      req({ kind: "pose", t: 1 / 30, emitter: 0, position: v(1), velocity: v(0), forward: v(1, 0, 0) }),
      req({ kind: "pose", t: 0, emitter: 1, position: v(10), velocity: v(0) }),
      req({ kind: "pose", t: 2, emitter: 1, position: v(20), velocity: v(0) }),
      req({ kind: "play", t: 0.5, instance: 1, path: "bike", emitter: 1, options: {} }),
    ]);
    expect(replay.poseAt(0, 1 / 60)!.position.x).toBeCloseTo(0.5);
    const f = replay.poseAt(0, 1 / 60)!.forward!;
    expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1);
    expect(replay.poseAt(1, 1)!.position.x).toBe(10); // still: held
    expect(replay.poseAt(1, 2 - 1 / 60)!.position.x).toBeCloseTo(15);
    expect(replay.poseAt(1, 5)!.position.x).toBe(20);
    expect(replay.poseAt(7, 1)).toBeNull();
    replay.play();
    at(0.6);
    expect(handles[0]!.options.position).toEqual(v(10));
    at(2 - 1 / 60);
    expect(handles[0]!.position!.x).toBeCloseTo(15);
    expect(poses.at(-1)!.position.x).toBe(1);
  });

  it("loops a range: at its end the instances alive at its start start again", () => {
    const { replay, at, log, handles } = setup([
      req({ kind: "play", t: 1, instance: 1, path: "a", emitter: null, options: {} }),
      req({ kind: "play", t: 3, instance: 2, path: "b", emitter: null, options: {} }),
      req({ kind: "play", t: 5, instance: 3, path: "c", emitter: null, options: {} }),
    ]);
    expect(replay.setLoop({ from: 2, to: 2.01 })).toBe(false);
    expect(replay.setLoop({ from: 4, to: 2 })).toBe(true);
    expect(replay.loop.value).toEqual({ from: 2, to: 4 });
    replay.play();
    expect(replay.time.value).toBe(2); // outside the range: from its start
    expect(handles.map((h) => h.path)).toEqual(["a"]);
    at(1.5); // 3.5
    expect(handles.map((h) => h.path)).toEqual(["a", "b"]);
    at(2.5); // past 4: back to 2.5
    expect(replay.time.value).toBeCloseTo(2.5);
    expect(replay.playing.value).toBe(true);
    expect(log).not.toContain("play c");
    expect(handles.filter((h) => h.playing).map((h) => h.path)).toEqual(["a"]);
    replay.setLoop(null);
    at(5.5); // played on past the old range, to 5.5
    expect(log).toContain("play c");
  });

  it("restarts the playing instances with their current parameters", () => {
    const { replay, at, handles } = setup([
      req({ kind: "play", t: 0, instance: 1, path: "a", emitter: null, options: { parameters: { X: 1 } } }),
      req({ kind: "param", t: 0.5, instance: 1, name: "X", value: 2 }),
      req({ kind: "release", t: 0.6, instance: 1 }),
      req({ kind: "play", t: 0, instance: 2, path: "b", emitter: null, options: {} }),
      req({ kind: "stop", t: 0.7, instance: 2, fade: 0 }),
    ]);
    replay.play();
    at(1);
    expect(replay.restartInstances()).toBe(1);
    const fresh = handles.at(-1)!;
    expect(handles[0]!.stopped).not.toBeNull();
    expect(fresh.path).toBe("a");
    expect(fresh.options.parameters).toEqual({ X: 2 });
    expect(fresh.released).toBe(true);
    expect(replay.instance(1)!.handle).toBe(fresh);
  });

  it("reseeds the picks' generator from the keyframe in force at a seek, after the keyframe's own instances start", () => {
    const { replay, log } = setup([
      { type: "keyframe", keyframe: { t: 0, instances: [], globals: {}, random: 111 } },
      req({ kind: "play", t: 0.5, instance: 1, path: "a", emitter: null, options: {} }),
      { type: "keyframe", keyframe: { t: 1, instances: [{ instance: 1, path: "a", started: 0.5, emitter: null, parameters: {} }], globals: {}, random: 222 } },
      req({ kind: "play", t: 1.5, instance: 2, path: "b", emitter: null, options: {} }),
    ]);
    replay.play();
    expect(log).toEqual(["seed 111"]);
    log.length = 0;
    replay.seek(1.7);
    // The keyframe's instance had made its picks before the keyframe; the play after it picks from the recorded state.
    expect(log.filter((l) => !l.startsWith("stop"))).toEqual(["play a", "seed 222", "play b"]);
    log.length = 0;
    replay.seek(0.2);
    expect(log.filter((l) => !l.startsWith("stop"))).toEqual(["seed 111"]);
  });

  it("says so when the runtime can't be seeded, and doesn't seed an unseeded take", () => {
    const a = setup([], META, { seeds: false });
    a.replay.play();
    expect(a.replay.note.value).toBe(UNSEEDED_NOTE);
    const b = setup([], { ...META, seeded: false });
    b.replay.play();
    expect(b.log).not.toContain("seed 9");
  });

  it("puts the mix back when it closes", () => {
    const { replay, at, log } = setup([
      req({ kind: "mix", t: 0.1, op: "masterVolume", target: "", value: 0.3, seconds: 0 }),
      req({ kind: "mix", t: 0.2, op: "busVolume", target: "SFX", value: 0.1, seconds: 0 }),
      req({ kind: "mix", t: 0.3, op: "snapshotStart", target: "Pause", value: 1, seconds: 0 }),
      req({ kind: "play", t: 0.4, instance: 1, path: "a", emitter: null, options: {} }),
    ]);
    replay.play();
    at(1);
    log.length = 0;
    replay.dispose();
    expect(log).toEqual(["stop a", "bus SFX=1/0", "clear/0", "master 1"]);
    replay.play();
    expect(replay.playing.value).toBe(false);
  });
});

describe("TakeReplay: lines, languages and dialogue says (ADR 0354 §10, 0355 §6)", () => {
  /** A target whose `say` picks from a table (what the current project would pick), and plays lines by key. */
  function sayTarget(picks: Record<string, string | null>) {
    const fake = fakeTarget();
    const lineHandle = (key: string): ReplayLineHandle => {
      let stopped = false;
      return {
        key, position: null,
        get state() { return stopped ? ("ended" as const) : ("playing" as const); },
        get playing() { return !stopped; },
        stop() { stopped = true; fake.log.push(`stop line ${key}`); },
        release() {}, setParameter() {}, trigger() {},
      };
    };
    fake.target.line = (key) => (fake.log.push(`line ${key}`), lineHandle(key));
    fake.target.say = (event, o) => {
      fake.log.push(`say ${event} ${JSON.stringify(o.args)}${o.channel ? ` @${o.channel}` : ""}`);
      const key = picks[event] ?? null;
      return key === null ? null : lineHandle(key);
    };
    fake.target.language = (audio, subtitles) => fake.log.push(`language ${audio}/${subtitles}`);
    return fake;
  }

  const records = [
    req({ kind: "language", t: 0.1, audio: "fr", subtitles: null }),
    req({ kind: "line", t: 0.2, instance: 1, key: "intro_01", language: "fr", options: { volume: 0.5 } }),
    req({ kind: "say", t: 0.3, instance: 2, event: "spotted", args: { speaker: "Guard", distance: "*" }, options: { channel: "Guard" }, state: "playing", picked: { key: "guard_near", pathIndex: 0 }, random: 1234 }),
    req({ kind: "say", t: 0.4, instance: 3, event: "chat", args: {}, options: {}, state: "playing", picked: { key: "chat_01", pathIndex: 0 }, random: 99 }),
    req({ kind: "stop", t: 0.5, instance: 1, fade: 0.1 }),
  ];

  function run(picks: Record<string, string | null>, recordedPicks = false) {
    const clock = { t: 100 };
    const fake = sayTarget(picks);
    const replay = new TakeReplay(new Take(META, records), fake.target, { now: () => clock.t });
    replay.replayRecordedPicks.value = recordedPicks;
    replay.play();
    fake.log.length = 0;
    clock.t = 101;
    replay.tick();
    return { replay, log: fake.log };
  }

  it("re-decides each say with its recorded arguments after restarting the generator from its recorded state", () => {
    const { replay, log } = run({ spotted: "guard_near", chat: "chat_01" });
    expect(log).toEqual([
      "language fr/null", "line intro_01",
      "seed 1234", 'say spotted {"speaker":"Guard"} @Guard', // `*` (matched only wildcards) is left to the default
      "seed 99", "say chat {}",
      "stop line intro_01",
    ]);
    expect(replay.pickDifferences.value.size).toBe(0);
  });

  it('marks the says whose replay picked differently ("picked X, recorded Y"), and only those', () => {
    const { replay } = run({ spotted: "guard_any", chat: "chat_01" });
    expect([...replay.pickDifferences.value.values()]).toEqual([{ instance: 2, event: "spotted", t: 0.3, picked: "guard_any", recorded: "guard_near" }]);
  });

  it("Replay recorded picks plays the recorded lines by key instead of deciding", () => {
    const { replay, log } = run({ spotted: "guard_any", chat: null }, true);
    expect(log).toEqual(["language fr/null", "line intro_01", "line guard_near", "line chat_01", "stop line intro_01"]);
    expect(replay.pickDifferences.value.size).toBe(0);
  });
});

describe("lane mute and solo (spec 4.5.4)", () => {
  const records = [
    req({ kind: "play", t: 0, instance: 1, path: "engine", emitter: null, options: {} }),
    req({ kind: "play", t: 0, instance: 2, path: "music", emitter: null, options: {} }),
    req({ kind: "play", t: 2, instance: 3, path: "boost", emitter: null, options: {} }),
  ];

  it("a muted path's playing instance stops at once and its later instances don't start; unmuting starts it where it is", () => {
    const { replay, at, alive } = setup(records);
    replay.play();
    at(0.5);
    expect(alive().map((h) => h.path).sort()).toEqual(["engine", "music"]);
    replay.setMuted("music", true);
    expect(alive().map((h) => h.path)).toEqual(["engine"]);
    replay.setMuted("boost", true);
    at(2.5);
    expect(alive().map((h) => h.path)).toEqual(["engine"]);
    replay.setMuted("music", false);
    const music = alive().find((h) => h.path === "music");
    expect(music?.options.offset).toBeCloseTo(2.5, 5);
  });

  it("while a path is soloed only soloed paths sound", () => {
    const { replay, at, alive } = setup(records);
    replay.play();
    at(0.5);
    replay.setSoloed("engine", true);
    expect(alive().map((h) => h.path)).toEqual(["engine"]);
    expect(replay.audible("music")).toBe(false);
    replay.setSoloed("engine", false);
    expect(alive().map((h) => h.path).sort()).toEqual(["engine", "music"]);
  });
});
