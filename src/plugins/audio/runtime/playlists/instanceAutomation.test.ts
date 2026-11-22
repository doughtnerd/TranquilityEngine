// D23: a playlist's own (instance-level) automation, through `Audio.play` on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "../events/eventTestKit";

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

  it("pan and effect parameters the adapter doesn't map are skipped with one warning each", async () => {
    await kit.boot({
      "w.playlist.json": pla("clip", [sample("a.wav")], {
        effects: [{ id: "r", type: "reverb" }],
        automation: [{ id: "p", target: "pan", curve: [[0, -1]] }, { id: "m", target: "fx:r:mix", curve: [[0, 0.5]] }],
      }),
    });
    Audio.play("w.playlist.json");
    Audio.play("w.playlist.json");
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes("pan automation"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('automation of "fx:r:mix"'))).toHaveLength(1);
    expect(fake.plays).toHaveLength(2);
  });
});
