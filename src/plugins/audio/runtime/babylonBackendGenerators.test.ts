// ADR 0360 §8 (G5): the Babylon fallback plays a generator as its offline render. The backend has the `generators`
// capability; a generator play renders through the committed offline module at the trigger's values, plays the render
// as a clip (an endless generator looped), warns once a session that parameters don't follow, and reuses the render for
// the same patch and seed. Against the mocked AudioV2 engine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { defaultGeneratorParams, generatorWireValues } from "../../../engine/audio/generators/catalogue";
import { renderResolvedGenerator } from "../../../engine/audio/generators/generatorRender";
import type { GeneratorKind } from "../../../engine/audio/generators/types";
import { babylonMock, type MockSound } from "../testing/babylonMocks";
import { babylonRig, decodingContext, disposeBabylonRigs, engine } from "../testing/babylonRig";
import { setAudioBackend, type GeneratorSource, type PlayRequest } from "./backend";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

function rig() {
  const { context, created } = decodingContext();
  const { backend } = babylonRig({ context });
  return { backend, created };
}

const sounds = (): MockSound[] => engine().sounds;
let warn: ReturnType<typeof vi.spyOn>;
const said = (text: string): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes(text));

const source = (kind: GeneratorKind, params: Record<string, number>, seed: number): GeneratorSource => ({ kind, values: generatorWireValues(kind, { ...defaultGeneratorParams(kind), ...params }), seed });
const genReq = (generator: GeneratorSource, extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "ui/beep.generator.json", url: "", loop: false, stream: false, bus: "SFX", volume: 1, generator, ...extra });

beforeEach(() => {
  babylonMock.reset();
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] }).settings);
  endAudioSession();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setAudioBackend(null);
  disposeBabylonRigs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ADR 0360 §8: generators on the Babylon fallback", () => {
  it("has the generators capability and plays a generator's offline render as a clip", async () => {
    const { backend, created } = rig();
    expect(backend.generators).toBeDefined();
    const beep = source("oscillator", { frequency: 880, length: 0.1 }, 42);
    const voice = backend.play(genReq(beep));
    expect(voice).not.toBeNull();
    await vi.waitFor(() => expect(sounds()).toHaveLength(1), { timeout: 10_000 });
    expect(created).toHaveLength(1);
    const want = await renderResolvedGenerator({ kind: beep.kind, values: [...beep.values], seed: beep.seed }, { rate: 48_000, loop: "buffer" });
    expect(created[0]!.channels).toBe(1);
    expect(created[0]!.rate).toBe(48_000);
    expect(created[0]!.length).toBe(want.frames);
    expect(Array.from(created[0]!.copied!)).toEqual(Array.from(want.pcm));
    // The sound plays that buffer on the voice's bus, not looping (the beep ends by its length).
    expect(sounds()[0]!.source).toBe(created[0]);
    expect(sounds()[0]!.options.loop).toBe(false);
    expect(said("plays nothing")).toEqual([]);
  });

  it("warns once a session that parameters don't follow, and loops an endless generator", async () => {
    const { backend } = rig();
    backend.play(genReq(source("oscillator", { length: 0.05 }, 1)));
    backend.play(genReq(source("synth", {}, 2)));
    backend.play(genReq(source("blip", {}, 3)));
    await vi.waitFor(() => expect(sounds()).toHaveLength(3), { timeout: 10_000 });
    expect(said("plays generators as offline renders")).toHaveLength(1);
    // The synth has no length: it sounds until released, so its 2 s render loops.
    const synth = sounds().find((s) => s.name.startsWith("ui/beep.generator.json#") && s.options.loop === true);
    expect(synth).toBeDefined();
    // A parameter change on a playing voice is accepted and does nothing.
    expect(() => backend.generators.setParams(backend.play(genReq(source("oscillator", { length: 0.05 }, 1)))!, new Map([[2, 220]]), 0.02)).not.toThrow();
  });

  it("reuses a render for the same patch and seed, and renders anew for another seed", async () => {
    const { backend, created } = rig();
    const blip = source("blip", { decay: 0.2 }, 7);
    backend.play(genReq(blip));
    backend.play(genReq(blip));
    await vi.waitFor(() => expect(sounds()).toHaveLength(2), { timeout: 10_000 });
    expect(created).toHaveLength(1);
    expect(sounds()[1]!.source).toBe(sounds()[0]!.source);
    backend.play(genReq({ ...blip, seed: 8 }));
    await vi.waitFor(() => expect(sounds()).toHaveLength(3), { timeout: 10_000 });
    expect(created).toHaveLength(2);
  });
});
