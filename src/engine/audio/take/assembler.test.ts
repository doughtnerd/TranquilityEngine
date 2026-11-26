// ADR 0417: the take assembler builds a `Take` from start facts, records as they come and META's take section, by
// `readTakeMeta`'s rules, for a take still recording and one that stopped.
import { describe, expect, it } from "vitest";
import { TakeAssembler, type TakeStartFacts } from "./assembler";
import type { TakeRecord } from "./records";

const FACTS: TakeStartFacts = { project: "Canyon", engine: "myco", device: "ua", startedMs: Date.UTC(2026, 10, 24, 9), audioHash: "0badf00d", seed: 7, seeded: true };
const mark = (t: number, text: string): TakeRecord => ({ type: "request", requests: [{ kind: "mark", t, text }] });
const frame = (t: number): TakeRecord => ({ type: "frame", frame: { t, width: 2, height: 1, jpeg: new Uint8Array(3) } });

describe("the take assembler", () => {
  it("builds a running take from the start facts, its records, emitters and clock", () => {
    const a = new TakeAssembler(FACTS);
    let take = a.running();
    if (typeof take === "string") throw new Error(take);
    expect(take.meta).toEqual({ project: "Canyon", engine: "myco", audioHash: "0badf00d", seed: 7, device: "ua", started: "2026-11-24T09:00:00.000Z", duration: 0, emitters: {}, frames: false });
    a.add(mark(0.4, "a"));
    a.name({ "0": "Listener", "3": "Car" });
    a.tick(0.2);
    take = a.running();
    if (typeof take === "string") throw new Error(take);
    expect(take.meta.duration).toBe(0.4); // the last record is later than the clock
    expect(take.meta.emitters).toEqual({ 0: "Listener", 3: "Car" });
    a.add(frame(0.5));
    a.tick(1.5);
    take = a.running();
    if (typeof take === "string") throw new Error(take);
    expect(take.meta).toMatchObject({ duration: 1.5, frames: true });
    expect(take.marks().map((m) => m.text)).toEqual(["a"]);
    expect(take.frames).toHaveLength(1);
  });

  it("says when the take's picks were unseeded, as readTakeMeta does", () => {
    const take = new TakeAssembler({ ...FACTS, seed: 0, seeded: false }).running();
    expect(typeof take !== "string" && take.meta.seeded).toBe(false);
  });

  it("builds a stopped take from META's section, with the emitters named so far beside a live end", () => {
    const a = new TakeAssembler(FACTS);
    a.add(mark(1, "x"));
    a.name({ "0": "Listener" });
    const end = { audioHash: "feedface", seed: 9, seeded: true, duration: 2.5, frames: false };
    const take = a.finished(end, true);
    if (typeof take === "string") throw new Error(take);
    expect(take.meta).toMatchObject({ audioHash: "feedface", seed: 9, duration: 2.5, emitters: { 0: "Listener" } });
    const file = a.finished({ ...end, emitters: { "4": "Door" } });
    expect(typeof file !== "string" && file.meta.emitters).toEqual({ 4: "Door" });
  });

  it("refuses META readTakeMeta refuses: a missing section, a bad seed, a long audio hash", () => {
    const a = new TakeAssembler(FACTS);
    expect(a.finished(undefined)).toBe("META has no take section");
    expect(a.finished({ audioHash: "", seed: -1, duration: 0, frames: false, emitters: {} })).toMatch(/seed/);
    expect(new TakeAssembler({ ...FACTS, audioHash: "f".repeat(65) }).running()).toMatch(/audioHash/);
  });
});
