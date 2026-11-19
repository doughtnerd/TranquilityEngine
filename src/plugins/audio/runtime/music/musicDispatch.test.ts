// ADR 0166 K2: `dispatchMusic` against a scripted predictor: which players are asked, which components hear what, in what
// order, with `missed` and `skippedCues` as `predictDue` wrote them, and what a throwing hook costs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicEvent, MusicKind } from "../../../../engine/audio/musicTypes";
import type { GameBehavior as GameBehaviorType } from "../../../../engine/core/Component";
import type { EventInstance } from "../events/eventRuntime";
import { endAudioSession } from "../testing";
import { emptySegment } from "../../../../engine/audio/musicFormat";

const asked: { kind: MusicKind; now: number; interval: number }[] = [];
const seated: { now: number; kind?: MusicKind }[] = [];
const script = new Map<MusicKind, Partial<MusicEvent>[]>();

vi.mock("./beatClock", () => ({
  predictDue: (_p: unknown, kind: MusicKind, now: number, interval: number, out: MusicEvent) => {
    asked.push({ kind, now, interval });
    const next = script.get(kind)?.shift();
    if (!next) return false;
    Object.assign(out, { segment: "A", bar: 1, beat: 1, tempo: 120, beatsPerBar: 4, time: now + 0.01, heardIn: 0.01, missed: 0, cue: undefined, skippedCues: undefined }, next);
    return true;
  },
  seatBeats: (_p: unknown, now: number, kind?: MusicKind) => seated.push({ now, kind }),
}));

// The test setup already loaded the real modules: reset, then import ones that see the mock. The behaviors sit on a real
// node of a headless Engine (no plugins: nothing else dispatches music), and `Audio.ts` registers the real handle factory.
let createMusicPlayer: typeof import("./musicSystem").createMusicPlayer;
let dispatchMusic: typeof import("./musicSystem").dispatchMusic;
let disposeMusicPlayer: typeof import("./musicSystem").disposeMusicPlayer;
let onMusicOf: typeof import("./musicSystem").onMusicOf;
let GameObjectClass: typeof import("../../../../engine/scene/GameObject").GameObject;
type GameObject = import("../../../../engine/scene/GameObject").GameObject;
type Frame = Parameters<typeof import("./musicSystem").dispatchMusic>[0];
type GameBehavior = GameBehaviorType;
let engine: import("../../../../engine/core/Engine").Engine | null = null;

const frame = (now: number): Frame => ({ backend: { frameInterval: () => 1 / 60 } as never, music: null, now, dt: 1 / 60, hidden: false });

interface Beater extends GameBehavior { log: string[] }
interface Barer extends GameBehavior { log: string[]; onMusicBar(e: MusicEvent): void }
let Plain: new () => GameBehavior, Beater: new () => Beater, Barer: new () => Barer;

/** A node of the test's Engine; its behaviors are what a music source on it delivers to. */
const newNode = (): GameObject => GameObjectClass.create("music");

/** A player whose `AudioSource` stands in as a plain behavior on `node`: the player's hooks live on that node. */
function rig(node: GameObject = newNode()) {
  const source = node.addBehavior(Plain);
  const instance = { group: 1, musicSource: source } as unknown as EventInstance;
  return Object.assign(createMusicPlayer(instance, emptySegment("r")), { node, source });
}

beforeEach(async () => {
  vi.resetModules();
  ({ createMusicPlayer, dispatchMusic, disposeMusicPlayer, onMusicOf } = await import("./musicSystem"));
  await import("../Audio");
  const { GameBehavior } = await import("../../../../engine/core/Component");
  ({ GameObject: GameObjectClass } = await import("../../../../engine/scene/GameObject"));
  const { Engine } = await import("../../../../engine/core/Engine");
  engine = await Engine.create({ headless: true });
  Plain = class extends GameBehavior {};
  Beater = class extends GameBehavior {
    log: string[] = [];
    onMusicBeat(e: MusicEvent): void { this.log.push(`beat ${e.bar}.${e.beat} missed ${e.missed}`); }
  };
  Barer = class extends GameBehavior {
    log: string[] = [];
    onMusicBar(e: MusicEvent): void { this.log.push(`bar ${e.bar}`); }
    onMusicCue(e: MusicEvent): void { this.log.push(`cue ${e.cue} skipped ${e.skippedCues?.join(",") ?? "-"}`); }
  };
  asked.length = 0;
  seated.length = 0;
  script.clear();
});
afterEach(() => {
  endAudioSession();
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
});

describe("dispatchMusic (K2)", () => {
  it("predicts nothing for a player no component or listener subscribes", () => {
    const node = newNode();
    node.addBehavior(Plain);
    rig(node);
    dispatchMusic(frame(1));
    expect(asked).toEqual([]);
    expect(seated).toEqual([]);
  });

  it("asks only the kinds some active behavior defines, with the frame's Audio.time and interval", () => {
    const node = newNode();
    const b = node.addBehavior(Beater);
    node.addBehavior(Plain);
    rig(node);
    script.set("beat", [{ bar: 2, beat: 3 }]);
    dispatchMusic(frame(1));
    expect(asked).toEqual([{ kind: "beat", now: 1, interval: expect.any(Number) }]);
    expect(b.log).toEqual(["beat 2.3 missed 0"]);
  });

  it("ignores a disabled or inactive behavior", () => {
    const node = newNode();
    const b = node.addBehavior(Beater);
    b.enabled = false;
    rig(node);
    dispatchMusic(frame(1));
    expect(asked).toEqual([]);
    b.enabled = true;
    dispatchMusic(frame(2));
    expect(asked.map((a) => a.kind)).toEqual(["beat"]);
    node.setActive(false);
    asked.length = 0;
    dispatchMusic(frame(3));
    expect(asked).toEqual([]);
  });

  it("gives every subscribed component the event, with the handle, missed and skippedCues", () => {
    const node = newNode();
    const b = node.addBehavior(Beater);
    const r = node.addBehavior(Barer);
    const seen: MusicEvent[] = [];
    const orig = r.onMusicBar.bind(r);
    r.onMusicBar = (e) => { seen.push({ ...e }); orig(e); };
    const beatSeen: MusicEvent[] = [];
    const origBeat = b.onMusicBeat.bind(b);
    b.onMusicBeat = (e) => { beatSeen.push({ ...e }); origBeat(e); };
    rig(node);
    script.set("beat", [{ missed: 3, beat: 2 }]);
    script.set("bar", [{ bar: 5 }]);
    script.set("cue", [{ cue: "hit", skippedCues: ["a", "b"], missed: 2 }]);
    dispatchMusic(frame(1));
    expect(b.log).toEqual(["beat 1.2 missed 3"]);
    expect(r.log).toEqual(["bar 5", "cue hit skipped a,b"]);
    // The player's one public handle (`Audio.ts`'s, the object `Audio.play` returns: audioApiM4), on every kind.
    expect(seen[0]!.handle).toEqual(expect.objectContaining({ onMusic: expect.any(Function) }));
    expect(beatSeen[0]!.handle).toBe(seen[0]!.handle);
  });

  it("seats a fresh subscription at now: all kinds from nothing, only the new kind among running ones", () => {
    const node = newNode();
    node.addBehavior(Beater);
    rig(node);
    dispatchMusic(frame(1));
    dispatchMusic(frame(2));
    expect(seated).toEqual([{ now: 1, kind: undefined }]);
    node.addBehavior(Barer);
    dispatchMusic(frame(3));
    expect(seated.slice(1)).toEqual([{ now: 3, kind: "bar" }, { now: 3, kind: "cue" }]);
  });

  it("a throwing hook is logged and the other components still hear the event", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const node = newNode();
    const bad = node.addBehavior(Beater);
    bad.onMusicBeat = () => { throw new Error("boom"); };
    const good = node.addBehavior(Beater);
    rig(node);
    script.set("beat", [{}]);
    dispatchMusic(frame(1));
    expect(good.log).toHaveLength(1);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("then calls listeners in subscription order, a throw not stopping the rest (K5 adds the subscribing)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const node = newNode();
    const b = node.addBehavior(Beater);
    const p = rig(node);
    const order: string[] = [];
    onMusicOf(p.instance, "beat", () => { order.push("l1"); throw new Error("x"); });
    onMusicOf(p.instance, "beat", () => order.push("l2"));
    script.set("beat", [{}]);
    dispatchMusic(frame(1));
    expect(order).toEqual(["l1", "l2"]);
    expect(b.log).toHaveLength(1);
  });

  it("a player with only listeners is predicted for their kinds; a destroyed source costs nothing", () => {
    const p = rig();
    const off = onMusicOf(p.instance, "bar", (e) => expect(e.bar).toBe(4));
    script.set("bar", [{ bar: 4 }]);
    dispatchMusic(frame(1));
    expect(asked.map((a) => a.kind)).toEqual(["bar"]);
    GameObjectClass.destroy(p.source);
    engine!.step(1 / 60); // destruction lands at the end of the frame
    off();
    asked.length = 0;
    dispatchMusic(frame(2));
    expect(asked).toEqual([]);
  });

  describe("onMusicOf, a music handle's subscription (K5)", () => {
    it("subscribes per kind, the unsubscribe stops it, a double unsubscribe is a no-op, the kind leaves the mask", () => {
      const p = rig();
      const got: string[] = [];
      const offBeat = onMusicOf(p.instance, "beat", (e) => got.push(`beat ${e.beat}`));
      onMusicOf(p.instance, "cue", () => got.push("cue"));
      script.set("beat", [{ beat: 2 }, { beat: 3 }]);
      dispatchMusic(frame(1));
      expect(asked.map((a) => a.kind)).toEqual(["beat", "cue"]);
      expect(got).toEqual(["beat 2"]);
      offBeat();
      offBeat();
      asked.length = 0;
      dispatchMusic(frame(2));
      expect(asked.map((a) => a.kind)).toEqual(["cue"]); // beat is no longer predicted
      expect(got).toEqual(["beat 2"]);
    });

    it("a kind joining the mask is seated at now; a re-subscribe owes no backlog", () => {
      const p = rig();
      const off = onMusicOf(p.instance, "bar", () => {});
      dispatchMusic(frame(1));
      expect(seated).toEqual([{ now: 1, kind: undefined }]);
      onMusicOf(p.instance, "beat", () => {});
      dispatchMusic(frame(2));
      expect(seated[1]).toEqual({ now: 2, kind: "beat" });
      off();
    });

    it("unsubscribing during dispatch: the caller's call finishes, a later listener unsubscribed by it is not called, others still are", () => {
      const p = rig();
      const order: string[] = [];
      let offC = () => {};
      const offA = onMusicOf(p.instance, "beat", () => { order.push("a"); offA(); offC(); });
      onMusicOf(p.instance, "beat", () => order.push("b"));
      offC = onMusicOf(p.instance, "beat", () => order.push("c"));
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      expect(order).toEqual(["a", "b"]);
      dispatchMusic(frame(2));
      expect(order).toEqual(["a", "b", "b"]);
    });

    it("a listener added during dispatch first hears the next event", () => {
      const p = rig();
      const order: string[] = [];
      onMusicOf(p.instance, "beat", () => { order.push("a"); if (order.length === 1) onMusicOf(p.instance, "beat", () => order.push("late")); });
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      dispatchMusic(frame(2));
      expect(order).toEqual(["a", "a", "late"]);
    });

    it("the same event object is reused per kind; the instance ending drops listeners and makes later unsubscribes and subscribes no-ops", () => {
      const p = rig();
      const seen: MusicEvent[] = [];
      const off = onMusicOf(p.instance, "beat", (e) => seen.push(e));
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      dispatchMusic(frame(2));
      expect(seen[0]).toBe(seen[1]);
      disposeMusicPlayer(p, null);
      expect(() => off()).not.toThrow();
      expect(() => onMusicOf(p.instance, "beat", () => {})()).not.toThrow();
      script.set("beat", [{}]);
      asked.length = 0;
      dispatchMusic(frame(3));
      expect(asked).toEqual([]); // the ended instance is predicted no more
      expect(seen).toHaveLength(2);
    });

    it("onMusicOf on a non-music instance returns a no-op", () => {
      expect(onMusicOf({}, "beat", () => {})).toBeTypeOf("function");
    });
  });
});
