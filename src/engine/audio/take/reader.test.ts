// ADR 0334: the take reader orders requests by time (file order among equal times) and answers spans, keyframes,
// pictures and seeks; `readTakeMeta` refuses a missing or malformed META take section.
import { describe, expect, it } from "vitest";
import { Take, readTakeMeta } from "./reader";
import type { TakeRecord } from "./records";
import type { TakeMeta, TakeRequest } from "./types";

const META: TakeMeta = { project: "P", engine: "myco", audioHash: "abcd", seed: 7, device: "ua", started: new Date(0).toISOString(), duration: 10, emitters: { 0: "Listener" }, frames: false };
const req = (q: TakeRequest): TakeRecord => ({ type: "request", requests: [q] });

describe("Take (ADR 0334)", () => {
  const records: TakeRecord[] = [
    { type: "keyframe", keyframe: { t: 0, instances: [], globals: { G: 0 } } },
    req({ kind: "play", t: 0.5, instance: 1, path: "a", emitter: null, options: {} }),
    req({ kind: "param", t: 1.2, instance: 1, name: "P", value: 1 }),
    { type: "keyframe", keyframe: { t: 1, instances: [{ instance: 1, path: "a", started: 0.5, emitter: null, parameters: {} }], globals: { G: 0 } } },
    req({ kind: "stop", t: 2, instance: 1, fade: 0 }),
    req({ kind: "play", t: 2, instance: 1, path: "b", emitter: null, options: {} }),
    req({ kind: "mark", t: 2.5, text: "here" }),
    { type: "frame", frame: { t: 1, width: 1, height: 1, jpeg: new Uint8Array(1) } },
    { type: "keyframe", keyframe: { t: 2, instances: [{ instance: 1, path: "b", started: 2, emitter: null, parameters: {} }], globals: { G: 0 } } },
  ];
  const take = new Take(META, records);

  it("orders requests by time, keeping file order among equal times", () => {
    expect(take.requests.map((q) => q.t)).toEqual([0.5, 1.2, 2, 2, 2.5]);
    const at2 = take.requestsAt(2);
    expect(at2.map((q) => q.kind)).toEqual(["stop", "play"]);
  });

  it("answers spans, the keyframe in force and the picture shown", () => {
    expect(take.requestsBetween(1, 2).map((q) => q.kind)).toEqual(["param"]);
    expect([...take.requestsFrom(2)].map((q) => q.kind)).toEqual(["stop", "play", "mark"]);
    expect(take.keyframeAt(-1)).toBeNull();
    expect(take.keyframeAt(1.5)?.t).toBe(1);
    expect(take.frameAt(0.5)).toBeNull();
    expect(take.frameAt(3)?.t).toBe(1);
    expect(take.marks().map((m) => m.text)).toEqual(["here"]);
    expect(take.paths()).toEqual(["a", "b"]);
    expect(take.duration).toBe(10);
  });

  it("seeks to the nearest keyframe and the requests after it up to the seek time", () => {
    const s = take.seek(1.9);
    expect(s.keyframe?.t).toBe(1);
    expect(s.requests.map((q) => q.kind)).toEqual(["param"]);
    const s2 = take.seek(2.6);
    expect(s2.keyframe?.t).toBe(2);
    expect(s2.requests.map((q) => q.kind)).toEqual(["stop", "play", "mark"]);
    const none = new Take(META, [req({ kind: "mark", t: 0.2, text: "x" })]).seek(1);
    expect(none.keyframe).toBeNull();
    expect(none.requests).toHaveLength(1);
  });
});

describe("readTakeMeta", () => {
  const cap = { project: { name: "P" }, engine: "myco", device: { userAgent: "ua" } };
  const good = { audioHash: "abcd", seed: 7, seeded: true, duration: 10, frames: false, emitters: { "0": "Listener", "3": "Player" } };

  it("reads the section with the capture's facts", () => {
    const m = readTakeMeta(cap, 0, good);
    expect(m).toEqual({ ...META, emitters: { 0: "Listener", 3: "Player" } });
    expect(readTakeMeta(cap, 0, { ...good, seeded: false })).toMatchObject({ seeded: false });
  });

  it("refuses a missing or malformed section", () => {
    for (const bad of [undefined, null, [], "x", { ...good, seed: -1 }, { ...good, seed: 1.5 }, { ...good, duration: -1 }, { ...good, audioHash: 3 }, { ...good, frames: "no" }, { ...good, emitters: { a: "x" } }, { ...good, emitters: [] }, { ...good, seeded: 1 }]) {
      expect(typeof readTakeMeta(cap, 0, bad), JSON.stringify(bad)).toBe("string");
    }
  });
});
