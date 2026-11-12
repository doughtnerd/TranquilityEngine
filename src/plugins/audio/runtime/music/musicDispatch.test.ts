// ADR 0166 K2: `dispatchMusic` against a scripted predictor: which players are asked, which components hear what, in what
// order, with `missed` and `skippedCues` as `predictDue` wrote them, and what a throwing hook costs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicEvent, MusicKind } from "../../../../engine/audio/musicTypes";
import type { GameBehavior as GameBehaviorType } from "../../../../engine/core/Component";
import type { EventInstance } from "../events/eventRuntime";

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

// The test setup already loaded the real modules: reset, then import ones that see the mock (and one `GameBehavior`).
let _resetMusicPlayers: typeof import("./musicSystem")._resetMusicPlayers;
let _setMusicHandleFactory: typeof import("./musicSystem")._setMusicHandleFactory;
let createMusicPlayer: typeof import("./musicSystem").createMusicPlayer;
let dispatchMusic: typeof import("./musicSystem").dispatchMusic;
let subscribeMusic: typeof import("./musicSystem").subscribeMusic;
let disposeMusicPlayer: typeof import("./musicSystem").disposeMusicPlayer;
let onMusicOf: typeof import("./musicSystem").onMusicOf;
type Frame = Parameters<typeof import("./musicSystem").dispatchMusic>[0];
type GameBehavior = GameBehaviorType;

const frame = (now: number): Frame => ({ backend: { frameInterval: () => 1 / 60 } as never, music: null, now, dt: 1 / 60, hidden: false });

interface Beater extends GameBehavior { log: string[] }
interface Barer extends GameBehavior { log: string[]; onMusicBar(e: MusicEvent): void }
let Plain: new () => GameBehavior, Beater: new () => Beater, Barer: new () => Barer;

function active<T extends GameBehavior>(c: T, on = true): T {
  c._active = on;
  return c;
}

/** A player whose `AudioSource` sits on entity 7 of a world holding `comps`. */
function rig(comps: GameBehavior[]) {
  const world = { _componentsOf: (e: number) => (e === 7 ? comps : []) };
  const source = { _destroyed: false, node: { isValid: true, entity: 7 }, owner: { entity: 7 }, _world: world };
  const instance = { group: 1, musicSource: source } as unknown as EventInstance;
  return createMusicPlayer(instance, { id: "r", type: "segment" });
}

beforeEach(async () => {
  vi.resetModules();
  ({ _resetMusicPlayers, _setMusicHandleFactory, createMusicPlayer, dispatchMusic, subscribeMusic, disposeMusicPlayer, onMusicOf } = await import("./musicSystem"));
  const { GameBehavior } = await import("../../../../engine/core/Component");
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
  _setMusicHandleFactory(() => ({ tag: "handle" }) as never);
});
afterEach(() => {
  _resetMusicPlayers();
  _setMusicHandleFactory(null);
  vi.restoreAllMocks();
});

describe("dispatchMusic (K2)", () => {
  it("predicts nothing for a player no component or listener subscribes", () => {
    rig([active(new Plain())]);
    dispatchMusic(frame(1));
    expect(asked).toEqual([]);
    expect(seated).toEqual([]);
  });

  it("asks only the kinds some active behavior defines, with the frame's Audio.time and interval", () => {
    const b = active(new Beater());
    const p = rig([b, active(new Plain())]);
    script.set("beat", [{ bar: 2, beat: 3 }]);
    dispatchMusic(frame(1));
    expect(asked).toEqual([{ kind: "beat", now: 1, interval: expect.any(Number) }]);
    expect(b.log).toEqual(["beat 2.3 missed 0"]);
    expect(p.hooks).toBe(1);
  });

  it("ignores a disabled or inactive behavior", () => {
    const b = active(new Beater(), false);
    rig([b]);
    dispatchMusic(frame(1));
    expect(asked).toEqual([]);
    b._active = true;
    dispatchMusic(frame(2));
    expect(asked.map((a) => a.kind)).toEqual(["beat"]);
  });

  it("gives every subscribed component the event, with the handle, missed and skippedCues", () => {
    const b = active(new Beater());
    const r = active(new Barer());
    const seen: MusicEvent[] = [];
    const orig = r.onMusicBar.bind(r);
    r.onMusicBar = (e) => { seen.push({ ...e }); orig(e); };
    rig([b, r]);
    script.set("beat", [{ missed: 3, beat: 2 }]);
    script.set("bar", [{ bar: 5 }]);
    script.set("cue", [{ cue: "hit", skippedCues: ["a", "b"], missed: 2 }]);
    dispatchMusic(frame(1));
    expect(b.log).toEqual(["beat 1.2 missed 3"]);
    expect(r.log).toEqual(["bar 5", "cue hit skipped a,b"]);
    expect(seen[0]!.handle).toEqual({ tag: "handle" });
  });

  it("seats a fresh subscription at now: all kinds from nothing, only the new kind among running ones", () => {
    const comps: GameBehavior[] = [active(new Beater())];
    rig(comps);
    dispatchMusic(frame(1));
    dispatchMusic(frame(2));
    expect(seated).toEqual([{ now: 1, kind: undefined }]);
    comps.push(active(new Barer()));
    dispatchMusic(frame(3));
    expect(seated.slice(1)).toEqual([{ now: 3, kind: "bar" }, { now: 3, kind: "cue" }]);
  });

  it("a throwing hook is logged and the other components still hear the event", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = active(new Beater());
    bad.onMusicBeat = () => { throw new Error("boom"); };
    const good = active(new Beater());
    rig([bad, good]);
    script.set("beat", [{}]);
    dispatchMusic(frame(1));
    expect(good.log).toHaveLength(1);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("then calls listeners in subscription order, a throw not stopping the rest (K5 adds the subscribing)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = active(new Beater());
    const p = rig([b]);
    const order: string[] = [];
    p.listeners = { beat: [() => { order.push("l1"); throw new Error("x"); }, () => order.push("l2")], bar: [], cue: [] };
    script.set("beat", [{}]);
    dispatchMusic(frame(1));
    expect(order).toEqual(["l1", "l2"]);
    expect(b.log).toHaveLength(1);
  });

  it("a player with only listeners is predicted for their kinds; a destroyed source costs nothing", () => {
    const p = rig([]);
    p.subscribed = 2;
    p.listeners = { beat: [], bar: [(e) => expect(e.bar).toBe(4)], cue: [] };
    script.set("bar", [{ bar: 4 }]);
    dispatchMusic(frame(1));
    expect(asked.map((a) => a.kind)).toEqual(["bar"]);
    (p.instance.musicSource as unknown as { _destroyed: boolean })._destroyed = true;
    p.subscribed = 0;
    asked.length = 0;
    dispatchMusic(frame(2));
    expect(asked).toEqual([]);
  });

  describe("subscribeMusic (K5)", () => {
    it("subscribes per kind, the unsubscribe stops it, a double unsubscribe is a no-op, the kind leaves the mask", () => {
      const p = rig([]);
      const got: string[] = [];
      const offBeat = subscribeMusic(p, "beat", (e) => got.push(`beat ${e.beat}`));
      subscribeMusic(p, "cue", () => got.push("cue"));
      expect(p.subscribed).toBe(1 | 4);
      script.set("beat", [{ beat: 2 }, { beat: 3 }]);
      dispatchMusic(frame(1));
      expect(got).toEqual(["beat 2"]);
      offBeat();
      offBeat();
      expect(p.subscribed).toBe(4);
      asked.length = 0;
      dispatchMusic(frame(2));
      expect(asked.map((a) => a.kind)).toEqual(["cue"]); // beat is no longer predicted
      expect(got).toEqual(["beat 2"]);
    });

    it("a kind joining the mask is seated at now; a re-subscribe owes no backlog", () => {
      const p = rig([]);
      const off = subscribeMusic(p, "bar", () => {});
      dispatchMusic(frame(1));
      expect(seated).toEqual([{ now: 1, kind: undefined }]);
      subscribeMusic(p, "beat", () => {});
      dispatchMusic(frame(2));
      expect(seated[1]).toEqual({ now: 2, kind: "beat" });
      off();
    });

    it("unsubscribing during dispatch: the caller's call finishes, a later listener unsubscribed by it is not called, others still are", () => {
      const p = rig([]);
      const order: string[] = [];
      let offC = () => {};
      const offA = subscribeMusic(p, "beat", () => { order.push("a"); offA(); offC(); });
      subscribeMusic(p, "beat", () => order.push("b"));
      offC = subscribeMusic(p, "beat", () => order.push("c"));
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      expect(order).toEqual(["a", "b"]);
      dispatchMusic(frame(2));
      expect(order).toEqual(["a", "b", "b"]);
    });

    it("a listener added during dispatch first hears the next event", () => {
      const p = rig([]);
      const order: string[] = [];
      subscribeMusic(p, "beat", () => { order.push("a"); if (order.length === 1) subscribeMusic(p, "beat", () => order.push("late")); });
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      dispatchMusic(frame(2));
      expect(order).toEqual(["a", "a", "late"]);
    });

    it("the same event object is reused per kind; the instance ending drops listeners and makes later unsubscribes and subscribes no-ops", () => {
      const p = rig([]);
      const seen: MusicEvent[] = [];
      const off = subscribeMusic(p, "beat", (e) => seen.push(e));
      script.set("beat", [{}, {}]);
      dispatchMusic(frame(1));
      dispatchMusic(frame(2));
      expect(seen[0]).toBe(seen[1]);
      disposeMusicPlayer(p, null);
      expect(p.listeners).toBeNull();
      expect(() => off()).not.toThrow();
      expect(p.subscribed).toBe(0);
      subscribeMusic(p, "beat", () => {})();
      expect(p.listeners).toBeNull();
    });

    it("onMusicOf on a non-music instance returns a no-op", () => {
      expect(onMusicOf({}, "beat", () => {})).toBeTypeOf("function");
    });
  });
});
