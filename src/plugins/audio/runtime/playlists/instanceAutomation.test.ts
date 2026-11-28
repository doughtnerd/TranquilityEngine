// D23: a playlist's own (instance-level) automation, through `Audio.play` on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;
const db = (x: number) => Math.pow(10, x / 20);
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const lastVolume = (i: number) => fake.voices[i]!.events.filter((e) => e.kind === "volume").map((e) => (e as { value: number }).value).at(-1);

describe("PlaylistBody.automation", () => {
  it("a voice-time volume lane counts from the playlist's start, for voices that start later too", async () => {
    await kit.boot({
      "s.playlist.json": pla("sequence", [], {
        automation: [{ id: "a", target: "volume", input: "voiceTime", curve: [[0, 0], [2, -20]] }],
        sequence: { length: 3, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c1", sample: "a.wav", at: 0, length: 3 }, { id: "c2", sample: "b.wav", at: 1, length: 1 }] }] },
      }),
    });
    fake.durations.set("a.wav", 3);
    fake.durations.set("b.wav", 1);
    Audio.play("s.playlist.json");
    expect(fake.plays[0]!.volume).toBeCloseTo(1, 6);
    at(0.95);
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    // b.wav starts at 1 s into the playlist: it starts at the lane's value there (-10 dB), not at its start (0 dB).
    expect(fake.plays[1]!.volume).toBeCloseTo(db(-10), 4);
    at(1.5);
    expect(lastVolume(0)).toBeCloseTo(db(-15), 4);
    expect(lastVolume(1)).toBeCloseTo(db(-15), 4);
  });

  it("a volume lane keyed at the −60 dB floor is silence, not 0.001 (ADR 0456)", async () => {
    await kit.boot({
      "s.playlist.json": pla("clip", [sample("a.wav")], { automation: [{ id: "a", target: "volume", input: "voiceTime", curve: [[0, -60], [2, -60]] }] }),
    });
    Audio.play("s.playlist.json");
    expect(fake.plays[0]!.volume).toBe(0);
  });

  it("a parameter-keyed lane on a gain effect binds: the voices follow the parameter (the effect's own gain is replaced)", async () => {
    await kit.boot({
      "g.playlist.json": pla("clip", [sample("a.wav")], {
        parameters: [{ name: "Speed", min: 0, max: 10, default: 10 }],
        effects: [{ id: "g", type: "gain", params: { gain: -6 } }],
        automation: [{ id: "a", target: "fx:g:gain", input: { parameter: "Speed" }, curve: [[0, -20], [10, 0]] }],
      }),
    });
    const h = Audio.play("g.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(1, 3);
    h.setParameter("Speed", 0);
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(0.1, 3);
  });

  it("enabled is a step on the gain; a low-pass cutoff lane moves the voices' filter", async () => {
    await kit.boot({
      "e.playlist.json": pla("clip", [sample("a.wav")], {
        playback: { plays: "untilStopped" },
        effects: [{ id: "lp", type: "lowpass", params: { cutoff: 20000 } }],
        automation: [
          { id: "on", target: "enabled", curve: [[0, 1], [1, 0]] },
          { id: "cut", target: "fx:lp:cutoff", curve: [[0, 8000], [2, 1000]] },
        ],
      }),
    });
    Audio.play("e.playlist.json");
    expect(fake.plays[0]!.filter?.lowpass).toBeCloseTo(8000, 3);
    at(0.5);
    expect(lastVolume(0) ?? fake.voices[0]!.volume).toBeCloseTo(1, 6);
    at(1.5);
    expect(lastVolume(0)).toBeLessThan(1e-5);
    const cutoffs = fake.voices[0]!.events.filter((e) => e.kind === "paramsShaped").map((e) => (e as { lowpassHz?: number }).lowpassHz);
    expect(cutoffs.at(-1)).toBeCloseTo(2750, 0);
  });

  it("effect parameters the adapter doesn't map are skipped with one warning each; pan is a voice control (ABI 4.4)", async () => {
    await kit.boot({
      "w.playlist.json": pla("clip", [sample("a.wav")], {
        effects: [{ id: "r", type: "reverb" }],
        automation: [{ id: "p", target: "pan", curve: [[0, -1]] }, { id: "m", target: "fx:r:mix", curve: [[0, 0.5]] }],
      }),
    });
    Audio.play("w.playlist.json");
    Audio.play("w.playlist.json");
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("pan automation"))).toHaveLength(0);
    expect(warnings.filter((w) => w.includes('automation of "fx:r:mix"'))).toHaveLength(1);
    expect(fake.plays).toHaveLength(2);
  });

  it("ABI 4.10: with an instance submix, a parameter-keyed lane of the root's own effect drives the submix's effect, not the voices", async () => {
    const automated: [number, { effect: string; param: number; log: boolean; input: unknown }[]][] = [];
    Object.assign(fake, {
      submixes: {
        open: () => true,
        close: () => {},
        levelOf: () => ({ slot: 0 }),
        openLevel: () => null,
        automate: (group: number, lanes: { effect: string; param: number; log: boolean; input: unknown }[]) => void automated.push([group, lanes.map((l) => ({ effect: l.effect, param: l.param, log: l.log, input: l.input }))]),
      },
    });
    try {
      await kit.boot({
        "s.playlist.json": pla("clip", [sample("a.wav")], {
          parameters: [{ name: "Open", min: 0, max: 1, default: 0 }],
          effects: [{ id: "lp", type: "lowpass", params: { cutoff: 500 } }, { id: "d", type: "delay" }],
          automation: [
            { id: "c", target: "fx:lp:cutoff", input: { parameter: "Open" }, curve: [[0, 500], [1, 18000]] },
            { id: "f", target: "fx:d:feedback", input: { parameter: "Open" }, curve: [[0, 0], [1, 60]] },
          ],
        }),
      });
      Audio.play("s.playlist.json");
      const group = fake.plays[0]!.group!;
      // The low-pass's cutoff in log scale (2^curve) and the delay's feedback: both on the submix, from the local parameter.
      expect(automated).toEqual([[group, [
        { effect: "lp", param: 0, log: true, input: { global: false, slot: 0 } },
        { effect: "d", param: 1, log: false, input: { global: false, slot: 0 } },
      ]]]);
      // The voice gets no low-pass cap from it (the D30 limit: it couldn't open above the effect's cutoff), and no warning.
      expect(fake.plays[0]!.filter).toBeUndefined();
      const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      expect(warnings.filter((w) => w.includes("needs instance submixes"))).toHaveLength(0);
    } finally {
      delete (fake as { submixes?: unknown }).submixes;
    }
  });
});
