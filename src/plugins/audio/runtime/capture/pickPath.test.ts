// ADR 0348: the "Why it played" chain. While a recorder's sink is installed, each playlist decision reaches it as a
// `pick` (after the instance's `eventStart`): a Switch's label and entry, a Blend's two heaviest entries, a Queue's pick,
// each with its nesting depth and playlist. Driven through `Audio.play` on the fake backend.
import { afterEach, describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "../playlists/testKit";
import { NULL_PROFILE_SINK, type ProfilePick } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";

const kit = eventKit();
const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone"], default: "Grass" }];
const SPEED = [{ name: "Speed", min: 0, max: 10, default: 0 }];

afterEach(() => {
  taps.sink = NULL_PROFILE_SINK;
});

describe("pick paths (ADR 0348)", () => {
  it("a Switch inside a Queue: the queue's pick, then the switch's label and entry, one level deeper", async () => {
    await kit.boot({
      "q.playlist.json": pla("queue", [{ embedded: { type: "switch", entries: [sample("a.wav"), sample("b.wav")], switch: { parameter: "Surface", map: { Grass: 0, Stone: 1 } } } }], { parameters: SURFACE }),
    });
    const rec = recordingSink();
    taps.sink = rec.sink;
    Audio.play("q.playlist.json", { parameters: { Surface: "Stone" } });
    const starts = rec.of("eventStart");
    expect(starts).toHaveLength(1);
    const instance = starts[0]![0] as number;
    const picks = rec.of("pick").map((c) => c[0] as ProfilePick);
    expect(picks.map((p) => [p.type, p.depth, p.choice, p.label])).toEqual([["queue", 0, 0, null], ["switch", 1, 1, "Stone"]]);
    expect(picks.every((p) => p.instance === instance && p.playlist === "q.playlist.json")).toBe(true);
    // The eventStart comes before the decisions.
    expect(rec.calls.findIndex((c) => c[0] === "eventStart")).toBeLessThan(rec.calls.findIndex((c) => c[0] === "pick"));
  });

  it("a Blend names its two heaviest entries with their weights", async () => {
    await kit.boot({
      "b.playlist.json": pla("blend", [sample("a.wav", { x: 0 }), sample("b.wav", { x: 5 }), sample("c.wav", { x: 10 })], {
        parameters: SPEED, blend: { axes: [{ parameter: "Speed" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 } },
      }),
    });
    const rec = recordingSink();
    taps.sink = rec.sink;
    Audio.play("b.playlist.json", { parameters: { Speed: 7.5 } });
    const [pick] = rec.of("pick").map((c) => c[0] as ProfilePick);
    expect(pick!.type).toBe("blend");
    expect(pick!.weights!.map(([entry]) => entry)).toEqual([1, 2]);
    expect(pick!.weights![0]![1] + pick!.weights![1]![1]).toBeCloseTo(1, 5);
    expect(pick!.choice).toBe(1);
  });

  it("a sequence's playlist clip is the sequence's pick (its place over all tracks and its id), before the picks inside it", async () => {
    await kit.boot({
      "q.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin" } }),
      "s.playlist.json": pla("sequence", [], { sequence: { length: 2, tracks: [
        { id: "t1", kind: "audio", clips: [{ id: "c1", sample: "c.wav", at: 0, length: 1 }] },
        { id: "t2", kind: "playlist", clips: [{ id: "p1", playlist: "q.playlist.json", at: 0, length: 1 }, { id: "p2", playlist: { type: "clip", entries: [sample("d.wav")] }, at: 1, length: 1 }] },
      ] } }),
    });
    const rec = recordingSink();
    taps.sink = rec.sink;
    Audio.play("s.playlist.json");
    for (let t = 0.1; t < 1.5; t += 0.1) { kit.setTime(t); kit.frame(); }
    const picks = rec.of("pick").map((c) => c[0] as ProfilePick);
    expect(picks.map((p) => [p.type, p.depth, p.choice, p.label, p.playlist])).toEqual([
      ["sequence", 0, 1, "p1", "s.playlist.json"],
      ["queue", 1, 0, null, "q.playlist.json"],
      ["sequence", 0, 2, "p2", "s.playlist.json"],
    ]);
  });

  it("nothing is reported while no recorder runs", async () => {
    await kit.boot({ "q.playlist.json": pla("queue", [sample("a.wav")]) });
    const rec = recordingSink();
    Audio.play("q.playlist.json");
    expect(rec.calls).toEqual([]);
  });
});
