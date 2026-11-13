// ADR 0171/0172 (Pf3d; api-and-models §5.6 kind 13, §7): the music state and transition tracks over `musicTransition` events
// recorded through the real `EventSink`. A tooltip is the string `transitionText` or `musicStateTooltip` builds, and it names
// the transition rule.
import { describe, expect, it } from "vitest";
import { EventKind } from "../../../runtime/capture/format";
import { eventLogFor, eventNames, type HoverTrackModule } from "./events";
import { MAX_MUSIC_LANES, musicSegments, musicStateLines, musicStateTooltip, musicTracks, musicTransitions, transitionRule, transitionText, transitionTooltip } from "./music";
import { recordScene, viewportTime, type Scene } from "./recordScene";

async function open(script: (s: Scene) => void) {
  const source = await recordScene(script);
  const tracks = musicTracks({ source, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } }) as HoverTrackModule[];
  await Promise.all(tracks.map((t) => t.refresh()));
  const [state, transitions] = tracks as [HoverTrackModule, HoverTrackModule];
  return { source, state, transitions, log: eventLogFor(source) };
}

describe("music state and transitions through the real EventSink", () => {
  const marks: Record<string, number> = {};
  const scene = (s: Scene) => {
    s.advance(0.4);
    marks.a = s.frame();
    s.sink.musicTransition(7, null, "Explore");
    s.advance(1.6);
    marks.b = s.frame();
    s.sink.musicTransition(7, "Explore", "Combat");
    s.sink.musicTransition(8, null, "Ambience");
    s.advance(2.8);
    marks.c = s.frame();
    s.sink.musicTransition(7, "Combat", "Explore");
    s.advance(3.5);
  };

  it("transitions are ticks at the recorded times, and the tooltip names the segments and the rule", async () => {
    const { source, transitions, log } = await open(scene);
    expect(Array.from(transitions.data()!.ticks!)).toEqual([viewportTime(source, marks.a!), viewportTime(source, marks.b!), viewportTime(source, marks.b!), viewportTime(source, marks.c!)]);
    const list = musicTransitions(log.ofKind(EventKind.musicTransition), eventNames(source));
    expect(list.map((t) => [t.instance, t.from, t.to])).toEqual([[7, null, "Explore"], [7, "Explore", "Combat"], [8, null, "Ambience"], [7, "Combat", "Explore"]]);
    transitions.tolerance = 0.005;
    const ta = viewportTime(source, marks.a!);
    expect(transitions.tooltipAt!(ta)).toBe(transitionTooltip(list, ta, 0.005));
    expect(transitions.tooltipAt!(ta)).toBe(`${ta.toFixed(3)} s  music 7: starts Explore  (rule: first segment, from nothing)`);
    const tb = viewportTime(source, marks.b!);
    expect(transitions.tooltipAt!(tb)).toBe(`${transitionText(list[1]!)}\n${transitionText(list[2]!)}`);
    expect(transitions.tooltipAt!(tb)).toContain("music 7: Explore → Combat  (rule: Explore → Combat)");
    expect(transitions.tooltipAt!(tb + 0.3)).toBeNull();
    expect(transitions.track).toMatchObject({ id: "music.transitions", kind: "ticks" });
    source.close();
  });

  it("the state track steps to each segment's number on a lane per instance; the hover says what plays and how it began", async () => {
    const { source, state, log } = await open(scene);
    const data = state.data()!;
    expect(data.lines).toHaveLength(2);
    const [i7, i8] = data.lines!;
    const valueAt = (line: typeof i7, t: number) => line!.values[Array.from(line!.times).filter((x) => x <= t + 1e-9).length - 1];
    // Segments by first appearance: Explore 1, Combat 2, Ambience 3.
    expect(valueAt(i7, viewportTime(source, marks.a!) + 0.3)).toBe(1);
    expect(valueAt(i7, viewportTime(source, marks.b!) + 0.3)).toBe(2);
    expect(valueAt(i7, viewportTime(source, marks.c!) + 0.3)).toBe(1);
    expect(valueAt(i8, viewportTime(source, marks.b!) + 0.3)).toBe(3);
    expect(valueAt(i8, viewportTime(source, marks.a!))).toBe(0);
    expect(i7!.yMax).toBe(3);
    const segments = musicSegments(musicTransitions(log.ofKind(EventKind.musicTransition), eventNames(source)));
    const t = viewportTime(source, marks.b!) + 0.3;
    expect(state.tooltipAt!(t)).toBe(musicStateTooltip(segments, t));
    expect(state.tooltipAt!(t)).toBe(
      `music 7: playing Combat since ${viewportTime(source, marks.b!).toFixed(3)} s  (rule: Explore → Combat)\n` +
      `music 8: playing Ambience since ${viewportTime(source, marks.b!).toFixed(3)} s  (rule: first segment, from nothing)`,
    );
    expect(state.tooltipAt!(0)).toBeNull();
    source.close();
  });

  it("a capture with no music has no data and no hover", async () => {
    const { state, transitions, source } = await open((s) => s.advance(1));
    expect([state.data(), transitions.data(), state.tooltipAt!(0.5), transitions.tooltipAt!(0.5)]).toEqual([undefined, undefined, null, null]);
    source.close();
  });
});

describe("the pure models", () => {
  it("a transition ends its instance's segment only; the rule of the first segment is 'from nothing'", () => {
    const t = (time: number, instance: number, from: string | null, to: string) => ({ time, instance, from, to });
    const segs = musicSegments([t(1, 1, null, "A"), t(2, 2, null, "X"), t(3, 1, "A", "B")]);
    expect(segs.map((s) => [s.instance, s.segment, s.start, s.end])).toEqual([[1, "A", 1, 3], [2, "X", 2, null], [1, "B", 3, null]]);
    expect(transitionRule(t(1, 1, null, "A"))).toBe("first segment, from nothing");
    expect(transitionRule(t(3, 1, "A", "B"))).toBe("A → B");
  });

  it("only the first MAX_MUSIC_LANES instances get a lane", () => {
    const segs = Array.from({ length: MAX_MUSIC_LANES + 2 }, (_, i) => ({ instance: i, segment: "S", start: 0, end: null, rule: "r" }));
    expect(musicStateLines(segs, [0, 1], 1)).toHaveLength(MAX_MUSIC_LANES);
  });
});
