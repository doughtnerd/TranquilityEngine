// T19: the editor's compile service in Node, compiling for real with the editor module on this thread (where the
// editor has no Worker it compiles in-thread, `runner.ts`). The runtime's question (`compiled`) answers null on a miss
// and starts the compile, then the cached bytes; settings and file changes make new keys; `refresh` compiles the clips
// that depend on a changed file again, and only those. The runner is wrapped to count compiles.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../../../../engine/scene/Assets";
import { animSourceToJson, emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { parseAnimationProjectSettings, type AnimationProjectSettings } from "../../../../engine/animation/compile/settings";
import { ClipCompileCache, memoryClipStore, type ClipCompileRunner } from "./cache";
import { inThreadRunner } from "./runner";
import { skinnedGltf } from "../../../../engine/tests/fixtures/gltf/skinnedGltf";
import { ClipCompileService } from "./service";

const SKEL = "anim/small.skel";
const WAVE = "clips/wave.anim.json";
const skelUrl = new URL("../../runtime/wasm/fixtures/small.skel", import.meta.url).href;

const wave = (amount: number): AnimSource => ({
  ...emptyAnimSource(),
  duration: 1,
  loop: true,
  tracks: [1, 2, 3].map((b) => ({ kind: "bone" as const, bone: `bone${b}`, translation: [], scale: [], rotation: [[0, 0, 0, 0, 1], [0.5, 0, Math.sin(amount * b), 0, Math.cos(amount * b)], [1, 0, 0, 0, 1]] as [number, number, number, number, number][] })),
});

let files: Record<string, unknown>;
let settings: AnimationProjectSettings;
let calls: number;
let service: ClipCompileService;
const request = { clip: WAVE, skeleton: SKEL };

beforeEach(() => {
  files = { [SKEL]: skelUrl, [WAVE]: animSourceToJson(wave(0.2)), "clips/other.anim.json": animSourceToJson(wave(0.4)) };
  Assets.clearSources();
  Assets.addSource({ has: (p) => p in files, get: (p) => files[p] });
  settings = parseAnimationProjectSettings(undefined).settings;
  calls = 0;
  const runner: ClipCompileRunner = (job) => (calls++, inThreadRunner(job));
  service = new ClipCompileService(new ClipCompileCache(memoryClipStore(), runner), { platform: () => "web", settings: () => settings, warn: () => {} });
});

describe("the editor's compile service", () => {
  it("answers the runtime null on a miss and compiles in the background, then the cached bytes", async () => {
    expect(await service.compiled(request)).toBeNull();
    await vi.waitFor(async () => expect(await service.clipReport(request)).not.toBeNull());
    const bytes = await service.compiled(request);
    expect(bytes).not.toBeNull();
    const result = await service.compileClip(request);
    expect("clip" in result && result.clip.bytes).toEqual(bytes);
    expect(calls).toBe(1);
  });

  // T70: the runtime swaps its raw clip for the compiled one in place, told when the background compile finishes.
  it("hands the background compile's bytes to the runtime when it finishes", async () => {
    const got: Uint8Array[] = [];
    expect(await service.compiled(request, (b) => got.push(b))).toBeNull();
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(await service.compiled(request)).toEqual(got[0]);
    expect(calls).toBe(1);
  });

  it("compiles with the report the Asset Inspector shows", async () => {
    const result = await service.compileClip(request);
    if (!("clip" in result)) throw new Error(result.error);
    expect(result.clip.report).toMatchObject({ withinBounds: true, fileSize: result.clip.bytes.length });
    expect(result.clip.report.maxError).toBeLessThanOrEqual(1e-4);
    expect(await service.clipReport(request)).toEqual(result.clip.report);
  });

  it("compiles again when the project's settings change the clip's settings", async () => {
    const a = await service.compileClip(request);
    settings = parseAnimationProjectSettings({ compression: { rules: [{ path: "clips/**", error: 5 }] } }).settings;
    const b = await service.compileClip(request);
    expect(calls).toBe(2);
    expect("clip" in a && "clip" in b && b.clip.key !== a.clip.key && b.clip.bytes.length < a.clip.bytes.length).toBe(true);
  });

  it("refreshes the clips that depend on a changed file, and only those", async () => {
    const first = await service.compileClip(request);
    await service.compileClip({ clip: "clips/other.anim.json", skeleton: SKEL });
    expect(calls).toBe(2);
    await service.refresh("images/unrelated.png");
    expect(calls).toBe(2);
    files[WAVE] = animSourceToJson(wave(0.6));
    await service.refresh(`asset:${WAVE}`);
    expect(calls).toBe(3);
    const now = await service.compileClip(request);
    expect("clip" in first && "clip" in now && now.clip.key !== first.clip.key).toBe(true);
    expect(calls).toBe(3); // a hit
    await service.refresh("project.json"); // settings may have changed: every known clip is checked; same keys, no compile
    expect(calls).toBe(3);
  });

  it("compiles a changed clip source nothing asked for when its skeleton is known: a clip without bones, a model's clips", async () => {
    files["clips/glow.anim.json"] = animSourceToJson({ ...emptyAnimSource(), tracks: [{ kind: "float", target: { nodePath: "", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, 1]]] }] });
    await service.refresh("clips/glow.anim.json");
    expect(calls).toBe(1);
    expect(await service.clipReport({ clip: "clips/glow.anim.json", skeleton: null })).not.toBeNull();
    await service.refresh("clips/other.anim.json"); // bone tracks, and no Animator has named its skeleton: nothing to compile against
    expect(calls).toBe(1);
    files["models/rig.gltf"] = `data:application/octet-stream;base64,${Buffer.from(skinnedGltf()).toString("base64")}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await service.refresh("models/rig.gltf.meta.json");
    warn.mockRestore();
    expect(calls).toBe(4); // the model's three clips (Walk, Wave, Bounce: one per take, no sidecar), against its own skeleton
    expect(await service.clipReport({ clip: "models/rig.gltf#Anim/Wave", skeleton: null })).toMatchObject({ withinBounds: true });
  });

  it("says why a clip can't compile", async () => {
    expect(await service.compileClip({ clip: "clips/missing.anim.json", skeleton: SKEL })).toEqual({ error: "clips/missing.anim.json: the clip can't be read." });
    expect(await service.compileClip({ clip: WAVE, skeleton: "anim/nope.skel" })).toEqual({ error: `${WAVE}: its skeleton "anim/nope.skel" can't be read.` });
    expect(await service.compiled({ clip: "clips/missing.anim.json", skeleton: null })).toBeNull();
  });
});
