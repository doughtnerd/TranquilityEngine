// ADR 0343: the playlist host's shared state (`host.ts`, the event runtime's `EventSystem` before the migration retired
// the event containers), driven through `Audio`, an `AudioSource` and the playlist runtime on the fake backend (the
// TypeScript automation evaluator runs). Ported from the event runtime's tests of the same behaviour: instance groups
// (E3.10), per-World generators (0158 §6, E3.6), the global parameter taps (Rc3), `syncSettings` (Ma1), samples played
// as one-sample playlists, and the refusal of the retired audio event format.
import { describe, expect, it, vi } from "vitest";
import { GameObject } from "../../../../myco";
import { World } from "../../../../engine/core/World";
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Audio } from "../index";
import { AudioSource } from "../AudioSource";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";
import { mulberry32, playlistHost, worldSeed } from "./host";
import { playlists } from "./playlistSystem";
import { embed, eventKit, pl, pla, sample } from "./testKit";
import { endAudioSession } from "../testing";

const kit = eventKit();
const fake = kit.fake;
const P = "p.playlist.json";
const DB = (g: number): number => 20 * Math.log10(g);
/** A playlist whose one sample's gain follows its local parameter Speed: 0 silent, 2 → 0.2, 5 → 0.5, 10 → 1. */
const speed = () => pla("layer", [embed(pl("clip", [sample("a.wav")]), { curves: { gain: { input: { parameter: "Speed" }, curve: [[0, -96], [2, DB(0.2)], [5, DB(0.5)], [10, 0]] } } })], {
  parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }],
});
const warnCount = (text: string) => vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes(text)).length;
const frame = () => playlistHost().update(1 / 60);

describe("instance groups (E3.10)", () => {
  it("a play right after a faded stop gets a different group, and its local parameter leaves the fading voice alone", async () => {
    await kit.boot({ [P]: speed() });
    const a = Audio.play(P, { parameters: { Speed: 5 } });
    frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5);
    a.stop(0.5); // the voice is fading out: not playing, still alive
    expect(fake.voices[0]!.alive).toBe(true);
    const b = Audio.play(P, { parameters: { Speed: 0 } });
    expect(fake.plays[1]!.group).toBeGreaterThan(0);
    expect(fake.plays[1]!.group).not.toBe(fake.plays[0]!.group);
    b.setParameter("Speed", 10);
    frame();
    expect(fake.voices[1]!.volume).toBeCloseTo(1);
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5); // the old voice kept its own Speed
  });

  it("a group comes back only after its last voice has ended", async () => {
    await kit.boot({ [P]: pla("layer", [sample("a.wav"), sample("b.wav")].map((s) => embed(pl("clip", [s])))) });
    const a = Audio.play(P);
    const g = fake.plays[0]!.group;
    a.stop(0.5);
    // Exhaust the never-used groups; the held group must not be handed out while either voice is still fading.
    const rest: number[] = [];
    for (let i = 0; i < 1023; i++) { Audio.play(P); rest.push(fake.plays.at(-1)!.group ?? -1); }
    expect(rest).not.toContain(g as number);
    Audio.play(P); // one more: nothing free
    expect(fake.plays.at(-1)!.group).toBe(0);
    fake.voices[0]!.end(); // one of the two voices ends: still held
    Audio.play(P);
    expect(fake.plays.at(-1)!.group).toBe(0);
    fake.voices[1]!.end(); // the last one ends: the group is free again
    Audio.play(P);
    expect(fake.plays.at(-1)!.group).toBe(g);
  });

  it("free groups are taken longest-free first, and a reused group's locals start from the new instance's values", async () => {
    await kit.boot({ [P]: speed() });
    const hs = [Audio.play(P, { parameters: { Speed: 8 } }), Audio.play(P), Audio.play(P)];
    const [g1, g2] = [fake.plays[0]!.group, fake.plays[1]!.group];
    for (let i = 3; i < 1024; i++) Audio.play(P);
    hs[0]!.stop(0); hs[1]!.stop(0); // g1 freed first, then g2
    Audio.play(P, { parameters: { Speed: 2 } });
    Audio.play(P);
    expect(fake.plays.slice(-2).map((p) => p.group)).toEqual([g1, g2]);
    frame();
    expect(fake.voices.at(-2)!.volume).toBeCloseTo(0.2);
  });

  it("1,025 live instances still warn once", async () => {
    await kit.boot({ [P]: pla("clip", [sample("a.wav")]) });
    for (let i = 0; i < 1025; i++) Audio.play(P);
    Audio.play(P);
    expect(fake.plays[1024]!.group).toBe(0);
    expect(warnCount("more than 1024 playlist instances at once")).toBe(1);
  });
});

describe("a generator per World (0158 §6)", () => {
  const RANDOM = () => ({ "r.playlist.json": pla("queue", ["a.wav", "b.wav", "c.wav"].map((s) => embed(pl("clip", [sample(s)])))) });
  const ROBIN = () => ({ "q.playlist.json": pla("queue", ["a.wav", "b.wav", "c.wav"].map((s) => embed(pl("clip", [sample(s)]))), { queue: { pick: "roundRobin" } }) });
  /** `n` triggers of `path` in World `world` (its key), and the samples they played. */
  function picks(path: string, world: number, n = 16): string[] {
    const from = fake.plays.length;
    for (let i = 0; i < n; i++) playlists().play(path, {}, world);
    return fake.plays.slice(from).map((p) => p.path);
  }

  it("the same seed and the same World give the same picks; another World's differ and neither disturbs the other", async () => {
    await kit.boot(RANDOM());
    const first = picks("r.playlist.json", 3);
    endAudioSession();
    await kit.boot(RANDOM());
    expect(picks("r.playlist.json", 3)).toEqual(first);
    expect(picks("r.playlist.json", 2)).not.toEqual(first);
    endAudioSession();
    await kit.boot(RANDOM());
    const alone = picks("r.playlist.json", 1, 8);
    endAudioSession();
    await kit.boot(RANDOM());
    const mixed: string[] = [];
    for (let i = 0; i < 8; i++) { mixed.push(...picks("r.playlist.json", 1, 1)); picks("r.playlist.json", 2, 1); }
    expect(mixed).toEqual(alone);
  });

  it("key 0 keeps mulberry32(seed) and other keys combine the key into the seed", () => {
    expect(worldSeed(7, 0)).toBe(7);
    expect(worldSeed(7, 1)).not.toBe(worldSeed(7, 2));
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a()]).toEqual([b(), b()]);
  });

  it("forgetting a World starts its generator and its picks over", async () => {
    await kit.boot({ ...RANDOM(), ...ROBIN() });
    const first = picks("r.playlist.json", 4, 8);
    expect(picks("q.playlist.json", 4, 2)).toEqual(["a.wav", "b.wav"]);
    playlistHost().forgetWorld(4);
    expect(picks("r.playlist.json", 4, 8)).toEqual(first);
    expect(picks("q.playlist.json", 4, 1)).toEqual(["a.wav"]);
  });

  it("keepWorlds forgets the Worlds the host no longer lists but not key 0; a key held by another World drops the old one's state", async () => {
    await kit.boot(ROBIN());
    picks("q.playlist.json", 0, 1);
    picks("q.playlist.json", 5, 1);
    playlistHost().keepWorlds(new Set());
    expect(picks("q.playlist.json", 0, 1)).toEqual(["b.wav"]); // key 0 kept its position
    expect(picks("q.playlist.json", 5, 1)).toEqual(["a.wav"]); // key 5 started over
    playlistHost().noteWorld(6, {} as never);
    picks("q.playlist.json", 6, 2);
    playlistHost().noteWorld(6, {} as never);
    expect(picks("q.playlist.json", 6, 1)).toEqual(["a.wav"]);
  });

  it("ADR 0462: worldOf names the World a key was noted for, not the active World; key 0 and an unnoted key give the active World", async () => {
    await kit.boot(ROBIN());
    const other = new World();
    expect(World.active).not.toBe(other);
    playlistHost().noteWorld(7, other);
    expect(playlistHost().worldOf(7)).toBe(other);
    expect(playlistHost().worldOf(0)).toBe(World.active);
    expect(playlistHost().worldOf(8)).toBe(World.active);
    playlistHost().forgetWorld(7);
    expect(playlistHost().worldOf(7)).toBe(World.active);
  });
});

describe("global parameters (Rc3 taps, Ma1)", () => {
  const PARAMS = [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 0 }, { name: "Surface", labels: ["Grass", "Stone", "Mud"], default: "Grass" }];
  function withSink<T>(fn: (stub: ReturnType<typeof recordingSink>) => T): T {
    const stub = recordingSink();
    taps.sink = stub.sink;
    try { return fn(stub); } finally { taps.sink = NULL_PROFILE_SINK; }
  }

  it("a numeric one is a parameter record with no instance (a repeat is none); a labelled one also a state change", async () => {
    await kit.boot({}, { parameters: PARAMS });
    withSink((stub) => {
      Audio.setParameter("Speed", 4);
      Audio.setParameter("Speed", 4);
      Audio.setParameter("Surface", "Mud");
      expect(stub.calls).toEqual([["parameter", "Speed", 4, null], ["parameter", "Surface", 2, null], ["stateChange", "Surface", "Mud"]]);
    });
    expect(Audio.getParameter("Surface")).toBe("Mud");
    Audio.setParameter("Nope", 1);
    expect(warnCount('no global audio parameter "Nope"')).toBe(1);
  });

  it("syncSettings re-reads the project's automation bindings and binds each bus again, without a script touching a parameter", async () => {
    await kit.boot({}, { parameters: [PARAMS[0]] });
    const bound: [string, number][] = [];
    (fake as unknown as { automation: unknown }).automation = {
      defineCurve: () => {}, setParam: () => {}, releaseGroup: () => {},
      bindBus: (bus: string, bindings: readonly unknown[]) => bound.push([bus, bindings.length]),
    };
    playlistHost().syncSettings();
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0]]);
    // A project edit adds an automation binding on SFX; nothing binds it until the host re-reads.
    mixer.configure(parseAudioSettings({
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }],
      parameters: [PARAMS[0]],
      automation: [{ bus: "SFX", parameter: "Speed", target: "volume", curve: [[0, 0], [10, 1]] }],
    }).settings);
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0]]);
    playlistHost().syncSettings();
    expect(bound.filter(([b]) => b === "SFX")).toEqual([["SFX", 0], ["SFX", 1]]);
    playlistHost().syncSettings(); // settled: nothing more
    expect(bound.filter(([b]) => b === "SFX")).toHaveLength(2);
  });
});

describe("what Audio.play and AudioSource accept (ADR 0343)", () => {
  it("a sample plays as a one-sample Clip playlist: a live handle, an instance row, its offset honoured", async () => {
    await kit.boot({});
    fake.durations.set("a.wav", 2);
    const h = Audio.play("a.wav", { volume: 0.5, offset: 0.25, bus: "SFX" });
    expect(h.playing).toBe(true);
    expect(fake.plays.map((p) => [p.path, p.offset, p.bus])).toEqual([["a.wav", 0.25, "SFX"]]);
    expect(Audio.debug().events.map((r) => r.asset)).toEqual(["a.wav"]);
    h.stop(0);
    expect(h.playing).toBe(false);
  });

  it("an old audio event file is refused with one warning naming the migration, from Audio.play and from an AudioSource", async () => {
    await kit.boot({ "e.audioevent.json": { format: "myco.audioevent@1", root: { type: "clip", clip: "a.wav" } } });
    const h = Audio.play("e.audioevent.json");
    Audio.play("e.audioevent.json");
    expect(h.playing).toBe(false);
    expect(fake.plays).toEqual([]);
    expect(warnCount("npm run audio:migrate")).toBe(1);
    expect(Audio.debug().playlistTotals?.refused.unsupported).toBe(2);
    const node = GameObject.create("src");
    const source = node.addComponent(AudioSource);
    source.clip = "e.audioevent.json";
    source.play();
    expect(source.isPlaying).toBe(false);
    expect(fake.plays).toEqual([]);
  });

  it("an AudioSource's pitch reaches every voice of its playing playlist live", async () => {
    await kit.boot({ [P]: pla("layer", [embed(pl("clip", [sample("a.wav")])), embed(pl("clip", [sample("b.wav")]))]) });
    const node = GameObject.create("src");
    const source = node.addComponent(AudioSource);
    source.clip = P;
    source.play();
    expect(fake.voices).toHaveLength(2);
    source.pitch = 1.5;
    kit.frame();
    for (const v of fake.voices) expect(v.pitch).toBeCloseTo(1.5, 6);
  });
});
