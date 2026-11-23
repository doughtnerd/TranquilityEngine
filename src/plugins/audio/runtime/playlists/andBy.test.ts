// ADR 0362 §5: second-input curves ("And by") at runtime, through `Audio.play` and `Audio.setParameter` on the fake
// backend (the TypeScript automation evaluator runs): playlist voice curves, sequence clip and track automation, a
// playlist's own automation, and the Mixer's bus automation (`audio.json`'s, through the automation sink a backend gets).
import { describe, expect, it } from "vitest";
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import { Audio } from "../index";
import { playlistHost } from "./host";
import { embed, eventKit, pl, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;
const db = (x: number) => Math.pow(10, x / 20);
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const lastVolume = (i: number) => fake.voices[i]!.events.filter((e) => e.kind === "volume").map((e) => (e as { value: number }).value).at(-1);
const seq = (sequence: Record<string, unknown>, extra: Record<string, unknown> = {}) => pla("sequence", [], { sequence, ...extra });

describe("voice curves with a second input", () => {
  it("scale: a parameter-keyed gain curve follows a second parameter; the voice moves when either changes", async () => {
    await kit.boot({
      "p.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), {
        curves: { gain: { input: { parameter: "Speed" }, curve: [[0, -20], [10, 0]], by: { input: "Load", mode: "scale", curve: [[0, 1], [1, 0.5]] } } },
      })], { parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }, { name: "Load", min: 0, max: 1, default: 0 }] }),
    });
    const h = Audio.play("p.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-20), 3);
    h.setParameter("Load", 1);
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-10), 3);
    h.setParameter("Speed", 5);
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-5), 3);
  });

  it("morph: a voice-time curve blends toward its High curve by a global parameter", async () => {
    await kit.boot({
      "p.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), {
        curves: { gain: { input: "voiceTime", curve: [[0, 0], [2, -20]], by: { input: "Rain", mode: "morph", curve: [[0, -20], [2, -20]] } } },
      })]),
    }, { parameters: [{ name: "Rain", min: 0, max: 1, default: 0 }] });
    Audio.play("p.playlist.json");
    at(1);
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-10), 3);
    Audio.setParameter("Rain", 0.5);
    at(1);
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-15), 3);
    Audio.setParameter("Rain", 1);
    at(1.5);
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-20), 3);
  });

  it("labels: each label of a labelled parameter plays its own curve, the first the lane's", async () => {
    await kit.boot({
      "p.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), {
        curves: { gain: { input: { parameter: "Speed" }, curve: [[0, -6]], by: { input: "Surface", mode: "labels", labels: { Wood: [[0, -12]] } } } },
      })], { parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }, { name: "Surface", labels: ["Dirt", "Gravel", "Wood"], default: "Dirt" }] }),
    });
    const h = Audio.play("p.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-6), 3);
    h.setParameter("Surface", "Wood");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-12), 3);
    h.setParameter("Surface", "Gravel");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(db(-6), 3);
  });
});

describe("sequence automation with a second input", () => {
  it("rate: a clip-time volume lane runs at the rate its second parameter gives", async () => {
    await kit.boot({
      "s.playlist.json": seq({
        length: 4,
        tracks: [{ id: "t", kind: "audio", clips: [{ id: "c1", sample: "a.wav", at: 0, length: 4, automation: [
          { id: "a1", target: "volume", input: "clipTime", curve: [[0, 0], [2, -20]], by: { input: "Speed", mode: "rate", curve: [[0, 1], [10, 2]] } },
        ] }] }],
      }, { parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(0.5);
    expect(lastVolume(0)).toBeCloseTo(db(-5), 4);
    h.setParameter("Speed", 10); // twice the rate: the lane reads clip time × 2
    at(0.5);
    expect(lastVolume(0)).toBeCloseTo(db(-10), 4);
  });

  it("a track's parameter-keyed pitch lane follows a second parameter (morph)", async () => {
    await kit.boot({
      "s.playlist.json": seq({
        length: 2,
        tracks: [{ id: "t", kind: "audio", automation: [
          { id: "p", target: "pitch", input: { parameter: "Speed" }, curve: [[0, 0], [10, 12]], by: { input: "Load", mode: "morph", curve: [[0, 12], [10, 12]] } },
        ], clips: [{ id: "c1", sample: "a.wav", at: 0, length: 2 }] }],
      }, { parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }, { name: "Load", min: 0, max: 1, default: 0 }] }),
    });
    fake.durations.set("a.wav", 2);
    const h = Audio.play("s.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.pitch).toBeCloseTo(1, 4);
    h.setParameter("Load", 0.5); // halfway to High: 6 semitones
    kit.frame();
    expect(fake.voices[0]!.pitch).toBeCloseTo(Math.pow(2, 6 / 12), 4);
  });

  it("a playlist's own enabled lane maps its slice to the step it is", async () => {
    await kit.boot({
      "e.playlist.json": pla("clip", [sample("a.wav")], {
        parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }, { name: "Mute", min: 0, max: 1, default: 0 }],
        automation: [{ id: "on", target: "enabled", input: { parameter: "Speed" }, curve: [[0, 1], [10, 1]], by: { input: "Mute", mode: "scale", curve: [[0, 1], [1, 0]] } }],
      }),
    });
    const h = Audio.play("e.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(1, 4);
    h.setParameter("Mute", 1); // × 0: enabled reads 0, off
    kit.frame();
    expect(fake.voices[0]!.volume).toBeLessThan(1e-5);
  });
});

describe("bus automation with a second input (audio.json)", () => {
  it("binds the lane's slice at the second parameter and redefines it when that parameter changes", async () => {
    const defined = new Map<number, Curve>();
    const bound = new Map<string, readonly { curve: number }[]>();
    await kit.boot({}, {
      mix: {
        parameters: [{ name: "Speed", min: 0, max: 10, default: 10 }, { name: "Load", min: 0, max: 1, default: 0 }],
        buses: [{ name: "Master", parent: null }, { name: "SFX", parent: "Master" }],
        automation: [{ on: "SFX", target: "volume", parameter: "Speed", curve: [[0, -20], [10, -10]], by: { input: "Load", mode: "scale", curve: [[0, 1], [1, 2]] } }],
      },
    });
    (fake as unknown as { automation: unknown }).automation = {
      defineCurve: (id: number, c: Curve) => defined.set(id, c), setParam: () => {}, releaseGroup: () => {},
      bindBus: (bus: string, bindings: readonly { curve: number }[]) => bound.set(bus, bindings),
    };
    playlistHost().syncSettings();
    const id = bound.get("SFX")![0]!.curve;
    expect(evalCurve(defined.get(id)!, 10)).toBeCloseTo(db(-10), 4);
    Audio.setParameter("Load", 1);
    expect(evalCurve(defined.get(id)!, 10)).toBeCloseTo(db(-20), 4);
    expect(evalCurve(defined.get(id)!, 0)).toBeCloseTo(db(-40), 4);
  });
});
