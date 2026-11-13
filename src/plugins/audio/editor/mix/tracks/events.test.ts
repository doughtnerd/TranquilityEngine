// ADR 0171/0172 (Pf3d; api-and-models §5.6, §7): the event, parameter and state tracks over events recorded through the real
// `EventSink`. Spans and ticks sit at the STATUS frame an event was recorded at; each tooltip is the string its model function
// builds; the sweep reads every keyframe interval (an event just before a keyframe included) in a bounded number of seeks.
import { describe, expect, it } from "vitest";
import { EMPTY_KEYFRAME } from "../../../runtime/capture/recorder";
import { SAMPLE_RATE } from "../../../runtime/capture/testSupport";
import type { CaptureSource } from "../profilerSource";
import {
  MAX_INSTANCE_LANES, MAX_TOOLTIP_LINES, assignLanes, eventLogFor, eventNames, eventSpans, eventTracks, formatValue, instanceLines, instanceTooltip,
  parameterChanges, parameterTooltip, spanText, stateChanges, stateTooltip, type EventSpan, type HoverTrackModule,
} from "./events";
import { EventKind } from "../../../runtime/capture/format";
import { recordScene, viewportTime, type Scene } from "./recordScene";

const names = (s: CaptureSource) => ({ clip: () => undefined, bus: () => undefined, event: () => undefined, source: s });

async function open(script: (scene: Scene) => void, opts?: Parameters<typeof recordScene>[1]) {
  const source = await recordScene(script, opts);
  const tracks = eventTracks({ source, names: names(source) }) as HoverTrackModule[];
  await Promise.all(tracks.map((t) => t.refresh()));
  const [instances, parameters, states] = tracks as [HoverTrackModule, HoverTrackModule, HoverTrackModule];
  return { source, instances, parameters, states, log: eventLogFor(source) };
}

/** Events across 4 s: three keyframe intervals. Frames are those of the STATUS each was recorded after. */
function script(marks: Record<string, number>) {
  return (s: Scene) => {
    s.advance(0.5);
    marks.explosionStart = s.frame();
    s.sink.eventStart(1, "Explosion");
    s.sink.eventStart(2, "Ambience");
    s.sink.parameter("intensity", 0.3, null);
    s.advance(1.5);
    marks.explosionStop = s.frame();
    s.sink.eventStop(1);
    s.sink.parameter("pitch", 1.25, 2);
    s.advance(2.5);
    marks.state = s.frame();
    s.sink.stateChange("Level", "Cave");
    s.advance(3);
    marks.lateStart = s.frame();
    s.sink.eventStart(3, "Late");
    s.advance(4);
  };
}

describe("event instance spans, parameters and state changes through the real EventSink", () => {
  it("spans start and stop at the recorded STATUS frames; an unstopped instance is still running", async () => {
    const marks: Record<string, number> = {};
    const { source, log } = await open(script(marks));
    const spans = eventSpans(log.ofKind(EventKind.eventStart), log.ofKind(EventKind.eventStop), log.initial, eventNames(source));
    expect(spans.map((s) => [s.name, s.instance, s.end === null])).toEqual([["Explosion", 1, false], ["Ambience", 2, true], ["Late", 3, true]]);
    expect(spans[0]!.start).toBeCloseTo(viewportTime(source, marks.explosionStart!), 9);
    expect(spans[0]!.end).toBeCloseTo(viewportTime(source, marks.explosionStop!), 9);
    expect(spans[1]!.start).toBeCloseTo(viewportTime(source, marks.explosionStart!), 9);
    expect(spans[2]!.start).toBeCloseTo(viewportTime(source, marks.lateStart!), 9);
    source.close();
  });

  it("the instances track is one lane line per concurrent instance: 1 inside a span, 0 outside, with samples at its edges", async () => {
    const marks: Record<string, number> = {};
    const { source, instances } = await open(script(marks));
    const data = instances.data()!;
    expect(data.lines).toHaveLength(2); // Explosion and Ambience overlap; Late reuses Explosion's lane
    const [a, b] = data.lines!;
    const t0 = viewportTime(source, marks.explosionStart!);
    const t1 = viewportTime(source, marks.explosionStop!);
    const at = (line: typeof a, t: number) => line!.values[line!.times.length ? Array.from(line!.times).findIndex((x) => Math.abs(x - t) < 1e-9) : -1];
    expect(at(a, t0)).toBe(1);
    expect(at(a, t1)).toBe(1); // the closing sample
    const mid = Array.from(a!.times).findIndex((x) => x > (t0 + t1) / 2);
    expect(a!.values[mid]).toBe(1);
    const after = Array.from(a!.times).findIndex((x) => x > t1 + 0.05);
    expect(a!.values[after]).toBe(0);
    expect(Array.from(b!.values).every((v, i) => (b!.times[i]! >= t0 - 1e-9 ? v === 1 : v === 0))).toBe(true); // Ambience runs to the end
    expect(instances.track).toMatchObject({ id: "events.instances", kind: "lanes" });
    source.close();
  });

  it("tooltips are the model functions' strings", async () => {
    const marks: Record<string, number> = {};
    const { source, instances, parameters, states, log } = await open(script(marks));
    const spans = eventSpans(log.ofKind(EventKind.eventStart), log.ofKind(EventKind.eventStop), log.initial, eventNames(source));
    const tIn = viewportTime(source, marks.explosionStart!) + 0.2;
    instances.tolerance = 0.01;
    expect(instances.tooltipAt!(tIn)).toBe(instanceTooltip(spans, tIn, 0.01, source.duration));
    expect(instances.tooltipAt!(tIn)).toBe(`${spanText(spans[1]!, source.duration)}\n${spanText(spans[0]!, source.duration)}`);
    expect(instances.tooltipAt!(tIn)).toContain('Explosion #1  ');
    expect(instances.tooltipAt!(tIn)).toContain("Ambience #2  ");
    expect(instances.tooltipAt!(tIn)).toContain("still running");

    const changes = parameterChanges(log.ofKind(EventKind.parameter), eventNames(source));
    expect(changes.map((c) => [c.name, c.instance, formatValue(c.value)])).toEqual([["intensity", null, "0.3"], ["pitch", 2, "1.25"]]);
    const tp = viewportTime(source, marks.explosionStart!);
    parameters.tolerance = 0.005;
    expect(parameters.tooltipAt!(tp)).toBe(parameterTooltip(changes, tp, 0.005));
    expect(parameters.tooltipAt!(tp)).toBe(`${tp.toFixed(3)} s  intensity = 0.3`);
    expect(parameters.tooltipAt!(viewportTime(source, marks.explosionStop!))).toMatch(/pitch = 1\.25 \(instance 2\)$/);
    expect(parameters.tooltipAt!(tp + 0.25)).toBeNull();

    const sc = stateChanges(log.ofKind(EventKind.stateChange), eventNames(source));
    const ts = viewportTime(source, marks.state!);
    states.tolerance = 0.005;
    expect(states.tooltipAt!(ts)).toBe(stateTooltip(sc, ts, 0.005));
    expect(states.tooltipAt!(ts)).toBe(`${ts.toFixed(3)} s  Level → Cave`);
    expect(instances.tooltipAt!(-5)).toBeNull();
    source.close();
  });

  it("parameters and state changes are ticks at their times, coloured by theme key", async () => {
    const marks: Record<string, number> = {};
    const { source, parameters, states } = await open(script(marks));
    const p = parameters.data()!;
    expect(Array.from(p.ticks!)).toEqual([viewportTime(source, marks.explosionStart!), viewportTime(source, marks.explosionStop!)]);
    expect(p.tickColor).toBe("accent2");
    expect(Array.from(states.data()!.ticks!)).toEqual([viewportTime(source, marks.state!)]);
    expect(states.track.kind).toBe("ticks");
    source.close();
  });

  it("every keyframe interval is read, an event stamped just before a keyframe included, in a bounded number of seeks", async () => {
    const stamped: number[] = [];
    // One event per STATUS block over 5 s: any boundary the sweep mis-places loses at least one of them.
    const { source, log } = await open((s) => {
      const end = 5 * SAMPLE_RATE;
      for (let k = 1; s.frame() < end; k++) {
        s.sink.parameter("tick", k, null);
        stamped.push(s.frame());
        s.step();
      }
    });
    const seen = log.ofKind(EventKind.parameter).map((e) => e.args[0]!);
    expect(seen).toHaveLength(stamped.length);
    expect(new Set(log.ofKind(EventKind.parameter).map((e) => e.seq)).size).toBe(stamped.length);
    const statuses = log.statusTimes.length;
    expect(statuses).toBeGreaterThan(300);
    expect(log.seeks).toBeLessThanOrEqual(Math.ceil(source.duration) * 12); // work done: a dozen seeks a captured second, not one per STATUS
    expect(log.seeks).toBeLessThan(statuses / 4);
    source.close();
  });

  it("refreshing again reads the capture once more without duplicating an event", async () => {
    const marks: Record<string, number> = {};
    const { source, instances, parameters, log } = await open(script(marks));
    const before = log.ofKind(EventKind.parameter).length;
    await Promise.all([instances.refresh(), parameters.refresh()]);
    expect(log.ofKind(EventKind.parameter)).toHaveLength(before);
    expect(Array.from(parameters.data()!.ticks!)).toHaveLength(2);
    source.close();
  });

  it("instances alive at the first keyframe are spans from 0 (a truncated start)", async () => {
    let stopFrame = 0;
    const { source, instances, log } = await open(
      (s) => {
        s.advance(1);
        stopFrame = s.frame();
        s.sink.eventStop(9);
        s.advance(1.5);
      },
      { keyframeSource: () => ({ ...EMPTY_KEYFRAME, events: [{ id: 9, asset: 4, voices: 1, state: 0, paramsHash: 0 }] }) },
    );
    const spans = eventSpans(log.ofKind(EventKind.eventStart), log.ofKind(EventKind.eventStop), log.initial, eventNames(source));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ instance: 9, asset: 4, start: 0, fromKeyframe: true, name: "event 4" });
    expect(spans[0]!.end).toBeCloseTo(viewportTime(source, stopFrame), 9);
    expect(instances.tooltipAt!(0.1)).toContain("before the capture");
    source.close();
  });

  it("a capture with no events has no data on any of the three tracks", async () => {
    const { source, instances, parameters, states } = await open((s) => s.advance(1));
    expect([instances.data(), parameters.data(), states.data()]).toEqual([undefined, undefined, undefined]);
    expect(instances.tooltipAt!(0.5)).toBeNull();
    source.close();
  });
});

describe("the pure models", () => {
  const span = (instance: number, start: number, end: number | null): EventSpan => ({ instance, asset: 1, name: "E", start, end, fromKeyframe: false });

  it("lanes: the first free lane, a new one up to the cap, then the last lane (counted)", () => {
    const spans = [span(1, 0, 10), span(2, 1, 2), span(3, 2, 3), span(4, 3, 9)];
    expect(assignLanes(spans)).toEqual({ lane: [0, 1, 1, 1], lanes: 2, overflow: 0 });
    const many = Array.from({ length: MAX_INSTANCE_LANES + 2 }, (_, i) => span(i, 0, null));
    const r = assignLanes(many);
    expect([r.lanes, r.overflow, r.lane[r.lane.length - 1]]).toEqual([MAX_INSTANCE_LANES, 2, MAX_INSTANCE_LANES - 1]);
  });

  it("a start of an open instance ends the earlier span; a stop of an unknown instance is ignored", () => {
    const ev = (kind: number, time: number, ...args: number[]) => ({ seq: time, time, kind, args, f32: undefined });
    const n = { parameter: String, event: (i: number) => `e${i}` };
    const out = eventSpans([ev(EventKind.eventStart, 1, 5, 1), ev(EventKind.eventStart, 3, 5, 2)], [ev(EventKind.eventStop, 4, 5), ev(EventKind.eventStop, 6, 77)], [], n);
    expect(out.map((s) => [s.start, s.end, s.name])).toEqual([[1, 3, "e1"], [3, 4, "e2"]]);
  });

  it("an open span draws to the end of the capture; a tooltip lists at most MAX_TOOLTIP_LINES and counts the rest", () => {
    const spans = Array.from({ length: MAX_TOOLTIP_LINES + 3 }, (_, i) => span(i, 0, null));
    const text = instanceTooltip(spans, 1, 0, 2)!;
    expect(text.split("\n")).toHaveLength(MAX_TOOLTIP_LINES + 1);
    expect(text.endsWith("+3 more")).toBe(true);
    const { lines } = instanceLines([span(1, 0.5, null)], [0, 1, 2], 2);
    expect(Array.from(lines[0]!.values)).toEqual([0, 1, 1, 1]); // grid 0, 0.5, 1, 2
  });
});
