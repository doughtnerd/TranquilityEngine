// ADR 0373 (T18b): a preview World poses a model through the runtime. The preview host gives a plugin a World of its own,
// loaded with the nodes `previewScene` builds and stepped every frame; `PosedClipPreview` asks its Animator for the clip at
// the playhead (`Animator.play(path, { speed: 0, normalizedTime })`), so the animation core evaluates the pose. Here the
// host's part is played by a plain `World("editor")` stepped by hand, which is all the host does (`ThumbnailScenes.prepareWorld`).
// Time comes from `world.step(dt)` and the playhead; the pose is read through the skinning matrices the render feature reads
// (`skeletonInstances.ts`). Fixtures: `small.skel` (12 bones) and `walk.anim`, compiled by anim-offline.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine } from "../../../../myco";
import { World } from "../../../../engine/core/World";
import { instantiateNodes } from "../../../../engine/editor";
import { animationCoreOf } from "../../runtime/core/service";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { prepareClip, PosedClipPreview } from "./posedPreview";
import { previewScene } from "./posedPreviewLogic";

const fixture = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const WALK = new Uint8Array(readFileSync(fixture("walk.anim")));
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const dt = 1 / 30;

let engine: Engine;

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "anim/small.skel": fixture("small.skel").href, "anim/walk.anim.bin": dataUrl(WALK) }));
  engine = await Engine.create({ headless: true });
});

afterAll(() => engine?.dispose());

/** A preview World as the host makes one: the scene's nodes, in a World of its own that never belongs to the Engine's list. */
function previewWorld(preview: PosedClipPreview) {
  const scene = previewScene([
    {
      name: "Preview",
      templates: [{ components: [{ type: "engine.Transform", data: {} }, { type: "engine.Skeleton", data: { skeleton: "anim/small.skel" } }, { type: "engine.Animator", data: { defaultClip: "asset:anim/other.anim" } }] }],
    },
  ]);
  const world = new World("editor", engine.world.settings);
  World._runIn(world, () => instantiateNodes(world, scene, world.root, "preview.scene.json", { onProblem: () => undefined }));
  const animator = world._componentsOfType(Animator)[0]!;
  /** One host frame: the plugin's hook, then the World's step. */
  const frame = () => {
    World._runIn(world, () => preview.frame(world));
    world.step(dt);
  };
  const pose = () => {
    const m = skinningMatrices(world, animator.node);
    return m ? Float32Array.from(m) : null;
  };
  return { world, animator, frame, pose };
}

/** Show the clip at `seconds` and read the pose once the core has evaluated it. */
async function poseAt(host: ReturnType<typeof previewWorld>, preview: PosedClipPreview, seconds: number): Promise<Float32Array> {
  preview.setTime(seconds);
  let last: Float32Array | null = null;
  // A play whose clip is still loading holds back; step until two frames in a row agree (speed 0: the pose is the time's).
  await vi.waitFor(
    () => {
      host.frame();
      const now = host.pose();
      expect(now).not.toBeNull();
      host.frame();
      const again = host.pose()!;
      const stable = last !== null && last.every((v, i) => v === again[i]) && now!.every((v, i) => v === again[i]);
      last = again;
      expect(stable).toBe(true);
    },
    { timeout: 10_000 },
  );
  return last!;
}

const differs = (a: Float32Array, b: Float32Array) => Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i]!)));

describe("a preview World poses a model through the runtime (T18b)", () => {
  it("shows a bone differently at two playhead times, and the same again when scrubbed back", async () => {
    const preview = new PosedClipPreview();
    const clip = await prepareClip(preview.files, "anim/walk.anim.bin");
    expect(clip).not.toBeNull();
    expect(clip!.duration).toBeGreaterThan(0);
    preview.setClip("Preview", clip!);
    const host = previewWorld(preview);
    try {
      const early = await poseAt(host, preview, clip!.duration * 0.1);
      const late = await poseAt(host, preview, clip!.duration * 0.6);
      expect(differs(early, late)).toBeGreaterThan(0.01); // the walk moved the bones
      const back = await poseAt(host, preview, clip!.duration * 0.1);
      expect(differs(early, back)).toBe(0); // the pose is a function of the playhead
    } finally {
      host.world._destroyAll();
      preview.dispose();
    }
  });

  it("starts the animation core for the preview World only, and a teardown releases its handles and the served clips", async () => {
    const preview = new PosedClipPreview();
    const clip = (await prepareClip(preview.files, "anim/walk.anim.bin"))!;
    preview.setClip("Preview", clip);
    expect(Assets.has(clip.path)).toBe(true);
    const host = previewWorld(preview);
    await vi.waitFor(() => expect(animationCoreOf(host.world)).not.toBeNull()); // the Animator started it, in this World
    expect(animationCoreOf(engine.world)).toBeNull(); // not in the Engine's
    await poseAt(host, preview, clip.duration * 0.3);
    const ns = animationCoreOf(host.world)!;
    // The handles the preview's Animator holds: asking for the same files again answers the same handles (one more reference each).
    const handles = [await ns.acquireFile("anim/small.skel", "skeleton"), await ns.acquireFile(clip.path, "clip")];
    for (const h of handles) {
      expect(h).not.toBe(0);
      expect(ns.core.references(h)).toBe(2); // the preview's, and the one just taken
      ns.release(h);
      expect(ns.core.references(h)).toBe(1);
    }
    host.world._destroyAll(); // what the host does when the preview stops
    expect(animationCoreOf(host.world)).toBeNull();
    for (const h of handles) expect(ns.core.references(h)).toBe(0);
    preview.dispose();
    expect(Assets.has(clip.path)).toBe(false);
  });

  it("leaves an Animator with no clip for its role at rest", async () => {
    const preview = new PosedClipPreview();
    const host = previewWorld(preview);
    try {
      await vi.waitFor(() => expect(animationCoreOf(host.world)).not.toBeNull());
      for (let i = 0; i < 5; i++) host.frame();
      expect(host.animator.state().weight).toBe(0); // nothing was played: the model keeps its rest pose
    } finally {
      host.world._destroyAll();
      preview.dispose();
    }
  });
});
