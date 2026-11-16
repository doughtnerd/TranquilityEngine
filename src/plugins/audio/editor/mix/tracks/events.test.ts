// ADR 0171/0172 (Pf3d; api-and-models §5.6, §7): the event, parameter and state tracks over events recorded through the real
// `EventSink`. Spans and ticks sit at the STATUS frame an event was recorded at; each tooltip is the string its model function
// builds; the sweep reads every keyframe interval (an event just before a keyframe included) in a bounded number of seeks.
import { describe, expect, it } from "vitest";
import { EMPTY_KEYFRAME_PAYLOAD as EMPTY_KEYFRAME } from "../../../runtime/capture/testSupport";
import { SAMPLE_RATE } from "../../../runtime/capture/testSupport";
import type { CaptureSource } from "../profilerSource";
import { MAX_TOOLTIP_LINES, eventLogFor, eventTracks, formatSeconds, formatValue, parameterChanges, eventNames, type HoverTrackModule } from "./events";
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
    const { source, instances } = await open(script(marks));
    instances.tolerance = 0;
    const start = viewportTime(source, marks.explosionStart!), stop = viewportTime(source, marks.explosionStop!), late = viewportTime(source, marks.lateStart!);
    // Hovering inside each span lists the running instances, most recently started first.
    expect(instances.tooltipAt!(start + 0.01)!.split("\n").map((l) => l.split("  ")[0])).toEqual(["Ambience #2", "Explosion #1"]);
    expect(instances.tooltipAt!(start + 0.01)).toContain(`Explosion #1  ${formatSeconds(start)} to ${formatSeconds(stop)} (${formatSeconds(stop - start)})`);
    expect(instances.tooltipAt!(start + 0.01)).toContain(`Ambience #2  ${formatSeconds(start)}, still running`);
    expect(instances.tooltipAt!(late + 0.01)!.split("\n")[0]).toMatch(new RegExp(`^Late #3  ${formatSeconds(late).replace(".", "\\.")}, still running`));
    expect(instances.tooltipAt!(stop + 0.05)).not.toContain("Explosion");
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
    const tIn = viewportTime(source, marks.explosionStart!) + 0.2;
    instances.tolerance = 0.01;
    expect(instances.tooltipAt!(tIn)!.split("\n")).toHaveLength(2);
    expect(instances.tooltipAt!(tIn)).toContain('Explosion #1  ');
    expect(instances.tooltipAt!(tIn)).toContain("Ambience #2  ");
    expect(instances.tooltipAt!(tIn)).toContain("still running");

    const changes = parameterChanges(log.ofKind(EventKind.parameter), eventNames(source));
    expect(changes.map((c) => [c.name, c.instance, formatValue(c.value)])).toEqual([["intensity", null, "0.3"], ["pitch", 2, "1.25"]]);
    const tp = viewportTime(source, marks.explosionStart!);
    parameters.tolerance = 0.005;
    expect(parameters.tooltipAt!(tp)).toBe(`${tp.toFixed(3)} s  intensity = 0.3`);
    expect(parameters.tooltipAt!(viewportTime(source, marks.explosionStop!))).toMatch(/pitch = 1\.25 \(instance 2\)$/);
    expect(parameters.tooltipAt!(tp + 0.25)).toBeNull();

    const ts = viewportTime(source, marks.state!);
    states.tolerance = 0.005;
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
    const stop = viewportTime(source, stopFrame);
    expect(log.initial).toHaveLength(1);
    expect(instances.tooltipAt!(0.1)).toBe(`event 4 #9  before the capture to ${formatSeconds(stop)} (${formatSeconds(stop)})`);
    expect(instances.data()!.lines).toHaveLength(1);
    expect(instances.data()!.lines![0]!.values[0]).toBe(1); // running from 0
    source.close();
  });

  it("a capture with no events has no data on any of the three tracks", async () => {
    const { source, instances, parameters, states } = await open((s) => s.advance(1));
    expect([instances.data(), parameters.data(), states.data()]).toEqual([undefined, undefined, undefined]);
    expect(instances.tooltipAt!(0.5)).toBeNull();
    source.close();
  });
});

describe("spans, lanes and the tooltip cap", () => {
  it("lanes: an instance overlapping all the others takes a new lane, up to six; later ones share the last", async () => {
    const { source, instances } = await open((s) => {
      s.advance(0.5);
      for (let i = 1; i <= 8; i++) s.sink.eventStart(i, `E${i}`);
      s.advance(1.5);
    });
    expect(instances.data()!.lines).toHaveLength(6);
    source.close();
  });

  it("a start of an open instance ends the earlier span; a stop of an unknown instance is ignored", async () => {
    const marks: Record<string, number> = {};
    const { source, instances } = await open((s) => {
      s.advance(0.5);
      marks.first = s.frame();
      s.sink.eventStart(5, "First");
      s.advance(1);
      marks.second = s.frame();
      s.sink.eventStart(5, "Second");
      s.advance(1.5);
      marks.stop = s.frame();
      s.sink.eventStop(5);
      s.sink.eventStop(77);
      s.advance(2);
    });
    instances.tolerance = 0;
    const [t1, t2, t3] = [marks.first!, marks.second!, marks.stop!].map((f) => viewportTime(source, f));
    expect(instances.tooltipAt!(t1 + 0.01)).toBe(`First #5  ${formatSeconds(t1!)} to ${formatSeconds(t2!)} (${formatSeconds(t2! - t1!)})`);
    expect(instances.tooltipAt!(t2! + 0.01)).toBe(`Second #5  ${formatSeconds(t2!)} to ${formatSeconds(t3!)} (${formatSeconds(t3! - t2!)})`);
    expect(instances.tooltipAt!(t3! + 0.2)).toBeNull();
    source.close();
  });

  it("an open span draws to the end of the capture; a tooltip lists at most MAX_TOOLTIP_LINES and counts the rest", async () => {
    const { source, instances } = await open((s) => {
      s.advance(0.5);
      for (let i = 1; i <= MAX_TOOLTIP_LINES + 3; i++) s.sink.eventStart(i, `E${i}`);
      s.advance(1.5);
    });
    const text = instances.tooltipAt!(1)!;
    expect(text.split("\n")).toHaveLength(MAX_TOOLTIP_LINES + 1);
    expect(text.endsWith("+3 more")).toBe(true);
    const line = instances.data()!.lines![0]!;
    expect(line.values[line.values.length - 1]).toBe(1); // still 1 at the capture's last sample
    source.close();
  });
});
