// F-35: music started while sound is locked (a page before its first gesture: the core still loading, the pending
// backend in its place) waits in `starting` and plays once the core arrives; it is refused only on a resolved backend
// without music. An exported game autoloads its music before any gesture, so this is how every web export starts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { audioBackend, isPendingCoreBackend, registerCoreBackend, resetCoreFallbackState, setAudioBackend } from "../backend";
import { Audio } from "../index";
import { makeFakeBackend } from "../testing";
import { events } from "../events/eventRuntime";
import { _resetMusicPlayers, musicPlanStep, musicPlayers } from "./musicSystem";
import { musicLoopback, resetMusicLoopback } from "./testing/loopbackClock";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";

// A page before its first gesture: the `myco.audio` service's load never settles here (in Node the probe would refuse
// and settle on "babylon" a few microtasks later, racing the test), so the pending backend stays until the test
// registers the core itself.
vi.mock("../core/probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/probe")>()),
  probeCoreSupport: () => new Promise(() => {}),
}));

const LEVEL = 0.125;
const EVENT = {
  format: "myco.audioevent@1",
  bus: "Music",
  root: {
    type: "segment", id: "A", tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }],
    regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }], tracks: [{ name: "t", clip: "a.wav" }],
  },
};
const NO_MUSIC = "no music support";
const noMusicWarned = (): boolean => vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes(NO_MUSIC));

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  resetMusicLoopback();
});

describe("music started before the unlock (F-35)", () => {
  it("waits on the pending backend, then starts on the core with its grid anchored there", async (ctx) => {
    const r = await musicLoopback({ clips: { "a.wav": { level: LEVEL, seconds: 4 } }, events: { "m.audioevent.json": EVENT }, locked: true });
    if (!r) return ctx.skip();
    const h = r.play("m.audioevent.json");
    expect(isPendingCoreBackend(audioBackend())).toBe(true);
    const player = r.player()!;
    expect(player).toBeDefined();
    // What a script may ask before the unlock: nothing throws, nothing is heard yet.
    const beats: MusicEvent[] = [];
    h.onMusic("beat", (e) => beats.push(e));
    expect(h.music).toBeDefined();
    expect(h.music!.segment).toBeNull();
    expect(h.music!.positionAt(performance.now()).segment).toBeNull();
    expect(() => h.trigger("nothing")).not.toThrow();
    await r.step(20);
    expect(player.state).toBe("starting"); // the debug row's `priming`
    expect(player.planned).toBeNull();
    expect(beats).toHaveLength(0);
    expect(noMusicWarned()).toBe(false);
    expect(r.out.every((s) => s === 0)).toBe(true);

    const mark = r.out.length;
    r.unlock();
    expect(isPendingCoreBackend(audioBackend())).toBe(false);
    await r.stepUntil(() => player.run?.state === "playing");
    const run = player.run!;
    expect(player.state).toBe("playing");
    expect(noMusicWarned()).toBe(false);
    // The first start is planned on the core's clock after the unlock, and the stem is heard from its planned frame.
    const planned = r.frameOfTime(run.startAt);
    expect(planned).toBeGreaterThan(mark);
    await r.step(10);
    expect(r.firstDeparture(mark, 0)).toBe(planned);
    expect(r.maxError(planned, r.out.length, LEVEL)).toBeLessThan(1e-4);
    expect(player.anchor).not.toBeNull();
    // Beat callbacks begin with the music: the first one is heard no earlier than the segment's start.
    await r.step(80);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]!.time).toBeGreaterThanOrEqual(run.startAt - 1e-6);
    expect(h.music!.segment).toBe("A");
    r.dispose();
  });
});

describe("a resolved backend without music still refuses (F-35)", () => {
  async function boot(): Promise<void> {
    setAudioBackend(null);
    resetCoreFallbackState();
    events()._reset();
    _resetMusicPlayers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", "m.audioevent.json": EVENT }));
    const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }], seed: 7, backend: "core" } } as never });
    await SceneManager.load("s.json");
    engine.world.render = {} as never;
  }

  it("the pending backend keeps it waiting; the backend the load settles on, without music, refuses it with one warning", async () => {
    await boot();
    Audio.play("m.audioevent.json");
    const player = musicPlayers()[0]!;
    musicPlanStep(audioBackend(), 1 / 60);
    expect(player.state).toBe("starting");
    expect(noMusicWarned()).toBe(false);

    const fake = makeFakeBackend();
    fake.music = undefined;
    undo = registerCoreBackend(() => fake);
    expect(audioBackend()).toBe(fake);
    musicPlanStep(audioBackend(), 1 / 60);
    expect(player.state).toBe("refused");
    expect(noMusicWarned()).toBe(true);
  });

  it("with music on the settled backend, the start is planned at the first step after the hand-over", async () => {
    await boot();
    Audio.play("m.audioevent.json");
    const player = musicPlayers()[0]!;
    musicPlanStep(audioBackend(), 1 / 60);
    expect(player.planned).toBeNull();
    const fake = makeFakeBackend();
    fake.facts.set("a.wav", { frames: 4 * 48_000, rate: 48_000, channels: 1, gapless: true });
    undo = registerCoreBackend(() => fake);
    musicPlanStep(audioBackend(), 1 / 60);
    // A decoded first segment is primed at once: it is stamped in this step's batch.
    expect(player.state).toBe("committed");
    expect(player.run?.state).toBe("stamped");
    expect(fake.music!.admitted.length).toBeGreaterThan(0);
    expect(noMusicWarned()).toBe(false);
  });
});
