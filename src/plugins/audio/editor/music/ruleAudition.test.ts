// Ed7: "audition this transition": the plan (which pair, which segment, where to start, which parameter) and the run
// through Ed5's transport against a fake audio host.
import { afterEach, describe, expect, it } from "vitest";
import { activeAudition } from "../event/auditionHost";
import { createTransport, type TransportHandle, type TransportHost } from "./transport";
import { auditionPair, leadBar, planTransitionAudition, runTransitionAudition } from "./ruleAudition";
import { containerOf, segmentRaw, switchEvent } from "./ruleFixtures";
import { leafSegments } from "./ruleLint";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";

const PATH = "m.audioevent.json";
const exitCue = { cues: [{ name: "exit", at: "9:1:0" }] };
const children = [segmentRaw("a", exitCue), segmentRaw("b"), segmentRaw("c")];

afterEach(() => { activeAudition.value = null; });

describe("auditionPair", () => {
  it("prefers the chosen pair when the rule wins it, else the first pair the rule wins", () => {
    const c = containerOf(switchEvent([{ from: "a", to: "b" }, { from: "b" }]));
    expect(auditionPair(c, 0)).toEqual({ from: "a", to: "b" });
    expect(auditionPair(c, 1)).toEqual({ from: "b", to: "a" });
    expect(auditionPair(c, 1, { from: "b", to: "c" })).toEqual({ from: "b", to: "c" });
    expect(auditionPair(c, 1, { from: "a", to: "b" })).toEqual({ from: "b", to: "a" });
  });
  it("is null for a rule that wins no pair of different children", () => {
    const c = containerOf(switchEvent([{ from: "a", to: "a" }]));
    expect(auditionPair(c, 0)).toBeNull();
    expect(auditionPair(c, 5)).toBeNull();
  });
});

describe("planTransitionAudition", () => {
  it("starts a music switch in the from child and asks for the to child's value, from two bars before the exit cue", () => {
    const event = switchEvent([{ from: "a", to: "b" }], { children });
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.segmentId).toBe("a");
    expect(plan.parameters).toEqual({ state: "1" });
    expect(plan.request).toEqual({ name: "state", value: "2" });
    expect(plan.from).toEqual({ kind: "bar", bar: 7 });
    expect(plan.note).toMatch(/bar 7/);
  });
  it("starts at the beginning when the exit is unknown, and honours a chosen bar", () => {
    const event = switchEvent([{ from: "a", to: "b" }]);
    const c = containerOf(event);
    const plan = planTransitionAudition(PATH, event, c, 0);
    expect(plan.ok && plan.from).toEqual({ kind: "start" });
    const at = planTransitionAudition(PATH, event, c, 0, { bar: 3 });
    expect(at.ok && at.from).toEqual({ kind: "bar", bar: 3 });
    const bad = planTransitionAudition(PATH, event, c, 0, { bar: 0 });
    expect(bad.ok && bad.from).toEqual({ kind: "start" });
    expect(leadBar(compileSegmentGrid(leafSegments(c)[0], { endSeconds: NaN }))).toBe(1);
  });
  it("uses the chosen pair for a wildcard rule", () => {
    const event = switchEvent([{ from: "*", to: "*" }]);
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0, { pair: { from: "c", to: "b" } });
    expect(plan.ok && plan.pair).toEqual({ from: "c", to: "b" });
    expect(plan.ok && plan.request).toEqual({ name: "state", value: "2" });
  });
  it("refuses with a reason: no such rule, not the root, a child with no value, no pair", () => {
    const event = switchEvent([{ from: "a", to: "b" }, { from: "a", to: "a" }]);
    const c = containerOf(event);
    const reason = (p: ReturnType<typeof planTransitionAudition>) => (p.ok ? "" : p.reason);
    expect(reason(planTransitionAudition(PATH, event, c, 9))).toMatch(/no longer exists/);
    expect(reason(planTransitionAudition(PATH, event, c, 1))).toMatch(/no pair/);
    expect(reason(planTransitionAudition(PATH, { ...event, musicRoot: { ...c, id: "other" } }, c, 0))).toMatch(/root/);
    const noValue = switchEvent([{ from: "a", to: "c" }], { children: [segmentRaw("a"), segmentRaw("b"), segmentRaw("c", { value: undefined })] });
    expect(reason(planTransitionAudition(PATH, noValue, containerOf(noValue), 0))).toMatch(/no value/);
  });
  it("plays a sequence playlist from its start and asks for nothing: the advance does it", () => {
    const event = switchEvent([{ from: "a", to: "b" }, { from: "b", to: "c" }], { type: "playlist" });
    const c = containerOf(event);
    const plan = planTransitionAudition(PATH, event, c, 0);
    expect(plan.ok && plan.request).toBeNull();
    expect(plan.ok && plan.parameters).toEqual({});
    expect(plan.ok && plan.note).toMatch(/advances to b/);
    const later = planTransitionAudition(PATH, event, c, 1);
    expect(later.ok).toBe(false);
  });
});

function fakeHandle(): TransportHandle & { sets: [string, number | string][]; seeks: string[] } {
  const h = {
    sets: [] as [string, number | string][], seeks: [] as string[], alive: true,
    get playing() { return h.alive; },
    music: { segment: "a", bar: 1, beat: 1, beatFraction: 0, seek: (t: string) => { h.seeks.push(t); return { ok: true as const, time: 1 }; } } as never,
    onMusic: () => () => undefined,
    trigger: () => true,
    stop: () => { h.alive = false; },
    setParameter: (n: string, v: number | string) => void h.sets.push([n, v]),
  };
  return h;
}

describe("runTransitionAudition", () => {
  it("plays through the transport with the start parameter and seek, then sets the target value after the seek lands", async () => {
    const handle = fakeHandle();
    const played: { path: string; parameters: Record<string, number | string> }[] = [];
    const host: TransportHost = {
      play: (path, parameters) => { played.push({ path, parameters }); return handle; },
      flush: async () => undefined,
      reload: () => undefined,
    };
    const transport = createTransport(host);
    const event = switchEvent([{ from: "a", to: "b" }], { children });
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0);
    if (!plan.ok) throw new Error(plan.reason);
    await runTransitionAudition(transport, plan);
    expect(played).toEqual([{ path: PATH, parameters: { state: "1" } }]);
    expect(handle.seeks).toEqual(["7:1:0"]);
    expect(activeAudition.value?.handle).toBe(handle);
    expect(handle.sets).toEqual([]);
    transport.tick();
    expect(handle.sets).toEqual([["state", "2"]]);
    transport.tick();
    expect(handle.sets).toHaveLength(1);
    transport.dispose();
  });
  it("holds the parameter until a refused-for-now seek lands", async () => {
    const handle = fakeHandle();
    let first = true;
    (handle.music as { seek: (t: string) => unknown }).seek = () => (first ? ((first = false), { ok: false, reason: "poolFull", permanent: false }) : { ok: true, time: 1 });
    const transport = createTransport({ play: () => handle, flush: async () => undefined, reload: () => undefined });
    const event = switchEvent([{ from: "a", to: "b" }], { children });
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0);
    if (!plan.ok) throw new Error(plan.reason);
    await runTransitionAudition(transport, plan);
    expect(handle.sets).toEqual([]);
    transport.tick();
    expect(handle.sets).toEqual([["state", "2"]]);
    transport.dispose();
  });
  it("holds the parameter while the music is still priming (no segment yet), from the default bar 1 too", async () => {
    const handle = fakeHandle();
    const music = handle.music as unknown as { segment: string | null };
    music.segment = null;
    const transport = createTransport({ play: () => handle, flush: async () => undefined, reload: () => undefined });
    const event = switchEvent([{ from: "a", to: "b" }], { children: [segmentRaw("a"), segmentRaw("b")] });
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.from).toEqual({ kind: "start" });
    await runTransitionAudition(transport, plan);
    transport.tick();
    transport.tick();
    expect(handle.sets).toEqual([]);
    music.segment = "a";
    transport.tick();
    expect(handle.sets).toEqual([["state", "2"]]);
    transport.dispose();
  });
  it("sets nothing for a playlist and says so for a handle that can't set parameters", async () => {
    const handle = fakeHandle();
    const transport = createTransport({ play: () => handle, flush: async () => undefined, reload: () => undefined });
    const event = switchEvent([{ from: "a", to: "b" }], { type: "playlist" });
    const plan = planTransitionAudition(PATH, event, containerOf(event), 0);
    if (!plan.ok) throw new Error(plan.reason);
    await runTransitionAudition(transport, plan);
    transport.tick();
    expect(handle.sets).toEqual([]);
    delete (handle as { setParameter?: unknown }).setParameter;
    expect(transport.requestParameter("state", "2")).toBe(false);
    expect(transport.state.value.message).toMatch(/can't set/);
    transport.dispose();
    expect(transport.requestParameter("state", "2")).toBe(false);
  });
});
