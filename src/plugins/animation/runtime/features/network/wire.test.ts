// T33: the Animator's replicated fields as strings (`wire.ts`): round trips, lenient decoding, the 255-byte cap.
import { describe, expect, it } from "vitest";
import { MAX_STR_BYTES } from "../../../../../engine/net/messages";
import { PARAMETER_STEP, decodeLinks, decodeParameters, decodeSlots, decodeStates, encodeLinks, encodeParameters, encodeSlots, encodeStates, quantizeParameter, type NetParameters, type NetSlot } from "./wire";

const slot = (tick: number, extra: Partial<NetSlot> = {}): NetSlot => ({ slot: "UpperBody", clip: "anims/slash.anim", tick, start: 0.1, end: 0, speed: 1, loop: false, fade: 0.2, stopTick: -1, stopFade: 0, ...extra });

describe("replicated Animator fields", () => {
  it("states round-trip; nothing to send is the empty string", () => {
    const states = [
      { machine: 0, state: 2, tick: 120 },
      { machine: 3, state: 0, tick: 7 },
    ];
    const e = encodeStates(states);
    expect(e.dropped).toBe(0);
    expect(decodeStates(e.raw)).toEqual(states);
    expect(encodeStates([]).raw).toBe("");
    expect(decodeStates("")).toEqual([]);
  });

  it("parameters round-trip with their tick; numbers quantise to 1/1024, integers and booleans don't", () => {
    expect(quantizeParameter(0.30001)).toBe(Math.round(0.30001 / PARAMETER_STEP) * PARAMETER_STEP);
    expect(quantizeParameter(7)).toBe(7);
    expect(quantizeParameter(true)).toBe(true);
    expect(quantizeParameter([0.5, 1 / 3])).toEqual([0.5, Math.round(1 / 3 / PARAMETER_STEP) * PARAMETER_STEP]);
    const p: NetParameters = { tick: 9, values: [[0, 0.5], [1, true], [2, [1, 2, 3]]] };
    expect(decodeParameters(encodeParameters(p).raw)).toEqual({ tick: 9, values: [[0, 0.5], [1, true], [2, [1, 2, 3]]] });
  });

  it("slots round-trip exactly (section times as written), newest first", () => {
    const a = slot(10, { start: 0.123456789, end: 0.75, loop: true, stopTick: 30, stopFade: 0.1 });
    const b = slot(20, { slot: "Full", clip: "anims/roll.anim" });
    expect(decodeSlots(encodeSlots([a, b]).raw)).toEqual([b, a]);
  });

  it("links round-trip, a null graph being the node's default", () => {
    const links = [
      { node: "Weapon", graph: "graphs/axe.animgraph.json", tick: 4 },
      { node: "Offhand", graph: null, tick: 5 },
    ];
    expect(decodeLinks(encodeLinks(links).raw)).toEqual(links);
  });

  it("decodes malformed strings as empty, entry by entry, and never throws", () => {
    expect(decodeStates("{nope")).toEqual([]);
    expect(decodeStates('[[0,1,2],["x",1,2],[0,-1,2]]')).toEqual([{ machine: 0, state: 1, tick: 2 }]);
    expect(decodeParameters("[1.5,[]]")).toBeNull();
    expect(decodeParameters('[3,[[0,"a"],[1,[1]],[2,false]]]')).toEqual({ tick: 3, values: [[2, false]] });
    expect(decodeSlots('[["s","",1,0,0,1,0,0,-1,0],["s","c",1,0,0,1,0,0,-1]]')).toEqual([]);
    expect(decodeLinks('[["n",7,1]]')).toEqual([]);
  });

  it("keeps every string within the replicated-string cap, leaving out the oldest slot plays first", () => {
    const many = Array.from({ length: 10 }, (_, i) => slot(i, { clip: `anims/a-rather-long-clip-name-${i}.anim` }));
    const e = encodeSlots(many);
    expect(new TextEncoder().encode(e.raw).byteLength).toBeLessThanOrEqual(MAX_STR_BYTES);
    expect(e.dropped).toBeGreaterThan(0);
    const kept = decodeSlots(e.raw);
    expect(kept.length).toBe(10 - e.dropped);
    expect(kept.map((s) => s.tick)).toEqual(Array.from({ length: kept.length }, (_, i) => 9 - i));
    const params = encodeParameters({ tick: 1, values: Array.from({ length: 100 }, (_, i) => [i, 0.5] as const) });
    expect(params.raw.length).toBeLessThanOrEqual(MAX_STR_BYTES);
    expect(params.dropped).toBeGreaterThan(0);
  });
});
