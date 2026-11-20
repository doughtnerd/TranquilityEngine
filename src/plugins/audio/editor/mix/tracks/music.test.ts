// ADR 0171/0172 (Pf3d; api-and-models §5.6 kind 13, §7): the music state and transition tracks over `musicTransition` events
// recorded through the real `EventSink`. A tooltip names the segments and the transition rule.
import { describe, expect, it } from "vitest";
import { type HoverTrackModule } from "./events";
import { musicTracks } from "./music";
import { recordScene, viewportTime, type Scene } from "./recordScene";

async function open(script: (s: Scene) => void) {
  const source = await recordScene(script);
  const tracks = musicTracks({ source }) as HoverTrackModule[];
  await Promise.all(tracks.map((t) => t.refresh()));
  const [state, transitions] = tracks as [HoverTrackModule, HoverTrackModule];
  return { source, state, transitions };
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
    const { source, transitions } = await open(scene);
    expect(Array.from(transitions.data()!.ticks!)).toEqual([viewportTime(source, marks.a!), viewportTime(source, marks.b!), viewportTime(source, marks.b!), viewportTime(source, marks.c!)]);
    transitions.tolerance = 0.005;
    const ta = viewportTime(source, marks.a!);
    expect(transitions.tooltipAt!(ta)).toBe(`${ta.toFixed(3)} s  music 7: starts Explore  (rule: first segment, from nothing)`);
    const tb = viewportTime(source, marks.b!);
    expect(transitions.tooltipAt!(tb)).toBe(`${tb.toFixed(3)} s  music 7: Explore → Combat  (rule: Explore → Combat)\n${tb.toFixed(3)} s  music 8: starts Ambience  (rule: first segment, from nothing)`);
    const tc = viewportTime(source, marks.c!);
    expect(transitions.tooltipAt!(tc)).toBe(`${tc.toFixed(3)} s  music 7: Combat → Explore  (rule: Combat → Explore)`);
    expect(transitions.tooltipAt!(tb + 0.3)).toBeNull();
    expect(transitions.track).toMatchObject({ id: "music.transitions", kind: "ticks" });
    source.close();
  });

  it("the state track steps to each segment's number on a lane per instance; the hover says what plays and how it began", async () => {
    const { source, state } = await open(scene);
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
    const t = viewportTime(source, marks.b!) + 0.3;
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

describe("lanes", () => {
  it("only the first four instances get a lane", async () => {
    const { source, state } = await open((s) => {
      s.advance(0.4);
      for (let i = 1; i <= 6; i++) s.sink.musicTransition(i, null, "S");
      s.advance(1.6);
    });
    expect(state.data()!.lines).toHaveLength(4);
    source.close();
  });

  it("a transition ends its own instance's segment only", async () => {
    const { source, state } = await open((s) => {
      s.advance(0.4);
      s.sink.musicTransition(1, null, "A");
      s.sink.musicTransition(2, null, "X");
      s.advance(1);
      s.sink.musicTransition(1, "A", "B");
      s.advance(1.6);
    });
    const lines = state.tooltipAt!(1.3)!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.startsWith("music 1: "))).toMatch(/playing B since .*\(rule: A → B\)$/);
    expect(lines.find((l) => l.startsWith("music 2: "))).toMatch(/playing X since .*\(rule: first segment, from nothing\)$/);
    source.close();
  });
});
