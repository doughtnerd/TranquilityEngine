// @internal Shared setup for the event runtime tests on the fake backend (ADR 0158 E3.5). Not shipped: only test files import it.
//
// Usage (top of a test file):
//   const kit = eventKit();            // registers beforeEach/afterEach for you
//   it("...", async () => { await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) }); ... kit.fake ... });
import { afterEach, beforeEach, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { events } from "./eventRuntime";

/** The event asset format tag. */
export const F = "myco.audioevent@1";
/** A `clip` node: `clip("a.wav", { weight: 2 })`. */
export const clip = (c: string, extra: Record<string, unknown> = {}) => ({ type: "clip", clip: c, ...extra });
/** An event asset: `ev(root, { bus: "SFX", limit: {...} })`. */
export const ev = (root: unknown, extra: Record<string, unknown> = {}) => ({ format: F, root, ...extra });

export interface EventKit {
  readonly fake: FakeBackend;
  /**
   * Registers `assets` (plus `s.json`, `a.wav`, `b.wav`, `c.wav`, `d.wav` as empty data URIs) and boots a headless Engine
   * with project audio buses Master and SFX (parent Master) and `seed` 7 (override or extend through `audio`).
   */
  boot(assets: Record<string, unknown>, audio?: Record<string, unknown>): Promise<void>;
  /** Sets the fake backend's heard clock (`fake.time`). */
  setTime(seconds: number): void;
}

/** Registers the per-test setup and teardown (fresh fake, `events()._reset()`, handle warnings reset, `console.warn` silenced). Call at file top level. */
export function eventKit(): EventKit {
  const fake = makeFakeBackend();
  beforeEach(() => {
    fake.clear();
    fake.ready = true;
    (fake as { time: number }).time = 0;
    setAudioBackend(fake);
    events()._reset();
    _resetHandleWarningsForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    events()._reset();
    setAudioBackend(null);
  });
  return {
    fake,
    async boot(assets, audio = {}) {
      Assets.clearSources();
      Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", "b.wav": "data:,", "c.wav": "data:,", "d.wav": "data:,", ...assets }));
      const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, ...audio } } });
      await SceneManager.load("s.json");
      engine.world.render = {} as never;
    },
    setTime(seconds) { (fake as { time: number }).time = seconds; },
  };
}
