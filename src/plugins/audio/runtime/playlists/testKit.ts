// @internal Shared setup for the playlist runtime tests on the fake backend (ADR 0329; first written for the audio event
// runtime, ADR 0158 E3.5). Not shipped: only test files import it.
//
// Usage (top of a test file):
//   const kit = eventKit();            // registers beforeEach/afterEach for you
//   it("...", async () => { await kit.boot({ "p.playlist.json": pla("clip", [sample("a.wav")]) }); ... kit.fake ... });
import { afterEach, beforeEach, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend, endAudioSession } from "../testing";

/** ADR 0329: the playlist format tag. */
export const PF = "myco.playlist@1";
/** A sample entry: `sample("a.wav", { volume: -6 })`. */
export const sample = (s: string, extra: Record<string, unknown> = {}) => ({ sample: s, ...extra });
/** An embedded playlist entry: `embed(pl("clip", [sample("a.wav")]), { weight: 2 })`. */
export const embed = (body: unknown, extra: Record<string, unknown> = {}) => ({ embedded: body, ...extra });
/** A linked playlist entry: `link("b.playlist.json")`. */
export const link = (path: string, extra: Record<string, unknown> = {}) => ({ playlist: path, ...extra });
/** A playlist body (embedded) of `type` with `entries`: `pl("queue", [...], { queue: { pick: "shuffle" } })`. */
export const pl = (type: string, entries: unknown[], extra: Record<string, unknown> = {}) => ({ type, entries, ...extra });
/** A playlist asset: `pla("queue", [...], {...})` (a body with the format line). */
export const pla = (type: string, entries: unknown[], extra: Record<string, unknown> = {}) => ({ format: PF, ...pl(type, entries, extra) });

export interface EventKit {
  readonly fake: FakeBackend;
  /**
   * Registers `assets` (plus `s.json`, `a.wav`, `b.wav`, `c.wav`, `d.wav` as empty data URIs) and boots a headless Engine
   * with project audio buses Master and SFX (parent Master) and `seed` 7 (override or extend through `audio`).
   */
  boot(assets: Record<string, unknown>, audio?: Record<string, unknown>): Promise<void>;
  /** Sets the fake backend's heard clock (`fake.time`). */
  setTime(seconds: number): void;
  /** Steps the booted Engine one frame of `dt` seconds: the audio system syncs every `AudioSource` (position, volume, pitch, output). */
  frame(dt?: number): void;
}

/** Registers the per-test setup and teardown (fresh fake, the audio session ended (`endAudioSession`), `console.warn` silenced). Call at file top level. */
export function eventKit(): EventKit {
  const fake = makeFakeBackend();
  let engine: Engine | null = null;
  beforeEach(() => {
    fake.clear();
    fake.ready = true;
    fake.advanceTo(0);
    setAudioBackend(fake);
    endAudioSession();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    endAudioSession();
    setAudioBackend(null);
  });
  return {
    fake,
    async boot(assets, audio = {}) {
      Assets.clearSources();
      Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", "b.wav": "data:,", "c.wav": "data:,", "d.wav": "data:,", ...assets }));
      engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, ...audio } } });
      await SceneManager.load("s.json");
      engine.world.render = {} as never;
    },
    setTime(seconds) { fake.advanceTo(seconds); },
    frame(dt = 1 / 60) {
      if (!engine) throw new Error("eventKit: boot() first");
      engine.step(dt);
    },
  };
}
