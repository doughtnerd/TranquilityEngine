// A3.4b: "only the World that has the view plays sound" reaches the core (architecture §3.9). Plays carry their World's
// key (`worldKeyOf`), and the audio system reports every attached World's view to `CoreBackend.setWorldAudible`, so the
// voices of a World without the view go virtual (in time, silent) and come back in time when the view returns. Run on the
// loopback (`loopbackAudio`, the real World service over its host: ADR 0234) with fake Worlds (only `render` is looked at).
import { afterEach, describe, expect, it } from "vitest";
import type { World } from "../../../engine/core/World";
import { setAudioBackend } from "./backend";
import { worldKeyOf } from "./AudioSource";
import { AUDIO_SYSTEMS } from "./audioSystem";
import { closeLoopbackAudio, loopbackAudio } from "./testing";

/** Frames a voice must lead before selection promotes it (selection.ts). */
const DWELL_FRAMES = 3;

interface FakeWorld {
  render: object | null;
  _componentsOfType(): never[];
}
const makeWorld = (render: object | null): FakeWorld => ({ render, _componentsOfType: () => [] });
const asWorld = (w: FakeWorld): World => w as unknown as World;

afterEach(closeLoopbackAudio);

/**
 * The loopback (ADR 0234) as the World service's core for two Worlds: each starts the real `myco.audio` service while it has
 * a view, then `other` hands its view back, as `Engine._handView` does when the view moves to another World.
 */
async function rig() {
  const audio = await loopbackAudio({ world: false });
  if (!audio) return null;
  const view = makeWorld({});
  const other = makeWorld({});
  await audio.startWorld(asWorld(view));
  await audio.startWorld(asWorld(other));
  other.render = null;
  const system = AUDIO_SYSTEMS[0]!;
  /** One engine frame: the system runs in each World the way `Engine.step` does (a World with no view only reports), then 4 quanta. */
  const frame = async (worlds: FakeWorld[]): Promise<number> => {
    for (const w of worlds) system.run(asWorld(w), 0.003);
    const { left } = audio.render(4);
    await Promise.resolve();
    return left[left.length - 1]!;
  };
  return { backend: audio.backend, view, other, frame };
}

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

describe("the World that has the view plays (A3.4b)", () => {
  it("worldKeyOf is the World's share key, 0 without the service", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    expect(worldKeyOf(asWorld(r.view))).toBe(1);
    expect(worldKeyOf(asWorld(r.other))).toBe(2);
    expect(worldKeyOf(asWorld(makeWorld(null)))).toBe(0);
    expect(worldKeyOf(null)).toBe(0);
  });

  it("a World without the view is forced virtual by the system, and comes back in time when the view moves to it", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { view, other, frame, backend } = r;
    const a = backend.play(req("a.wav", { volume: 0.5, world: worldKeyOf(asWorld(view)) }))!;
    const b = backend.play(req("b.wav", { volume: 0.25, world: worldKeyOf(asWorld(other)) }))!;
    let level = 0;
    for (let i = 0; i < 12; i++) level = await frame([view, other]);
    // only the view's World is heard
    expect(level).toBeCloseTo(0.5 * 0.5, 5);
    expect(a.reason).toBeNull();
    expect(b.reason).toBe("virtual");
    expect(b.playing).toBe(true);
    // the view moves to the other World (the hand-over `Engine._handView` does)
    const surface = view.render;
    view.render = null;
    other.render = surface;
    for (let i = 0; i < 2; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.5 * 0.25, 4);
    expect(a.reason).toBe("virtual");
    expect(a.playing).toBe(true);
    // and back
    other.render = null;
    view.render = surface;
    for (let i = 0; i < DWELL_FRAMES + 2; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.5 * 0.5, 4);
    expect(a.reason).toBeNull();
    expect(b.reason).toBe("virtual");
  });

  it("a World that no longer steps (paused) is silenced by the one that does", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { view, other, frame, backend } = r;
    // `other` has the view first and plays; then the view moves to `view`, and only `view` steps
    other.render = view.render;
    view.render = null;
    const b = backend.play(req("b.wav", { volume: 0.5, world: worldKeyOf(asWorld(other)) }))!;
    let level = 0;
    for (let i = 0; i < 12; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.25, 5);
    view.render = other.render;
    other.render = null;
    for (let i = 0; i < 2; i++) level = await frame([view]); // `other` is paused and isn't stepped
    expect(level).toBe(0);
    expect(b.reason).toBe("virtual");
  });

  it("does nothing, and creates no backend, while none exists", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    setAudioBackend(null);
    // (a new backend would be made by `audioBackend()`; the system must not call it before first sound)
    expect(() => AUDIO_SYSTEMS[0]!.run(asWorld(r.other), 0.01)).not.toThrow();
  });
});
