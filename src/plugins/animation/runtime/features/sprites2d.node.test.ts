// ADR 0370, 0371 (T21): sprites and 2D bones in a headless Engine through the public API (`myco`).
// - Flipbooks: an image sidecar's `flipbooks.<name>` plays as the clip `image.png#Flip/<name>` on an Animator without a
//   skeleton (a zero-bone instance, D109), stepping `SpriteRenderer.sprite` through the slices.
// - Skeleton2D: its skeleton comes from a slice's `skin.bones`; an Animator on its node plays bone tracks on it; skinned
//   slices (two sharing the skeleton) are deformed by the kernel's JavaScript executor and handed to quad batches
//   (`SkinnedSprites` over a fake `QuadBatchHost`, as the renderer's feature uses it). The bone clip is a raw clip
//   written by `writeRawClip` with the skeleton's bones, served as a data URL.
// Time comes from `engine.step(dt)` only. Positions are compared to 4 decimals (5e-5): the pose (core) and the kernel
// are f32, on values near 1.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton2D, SpriteRenderer } from "../../../../myco";
import { isFieldAnimatable } from "../../../../engine/core/registry";
import { skeleton2D, sliceFrame } from "../../../../engine/animation/sprites/skeleton2d";
import { memoryQuadHost, type MemoryQuadBatch } from "../../../../engine/tests/memoryQuadHost";
import { drawPlace } from "../../../../engine/render/sortOrder";
import { instanceForSkeleton } from "../skeletonInstances";
import { claimsSkinnedSprite, SkinnedSprites } from "./sprites2d/skinnedSprites";
import { writeRawClip } from "./timeline/rawClip";

let engine: Engine;
/** The project's sorting layers: `Units` is y-sorted (ADR 0440), `Default` isn't. */
const RENDER = { sortingLayers: ["Default", "Units"], ySortedLayers: ["Units"] };
const made: GameObject[] = [];

const SHEET = {
  format: "myco.import@1",
  sprites: [0, 1, 2, 3].map((i) => ({ name: `run_${i}`, rect: [i * 16, 0, 16, 16], pivot: [0.5, 0] })),
  flipbooks: { run: { slices: ["run_0", "run_1", "run_2", "run_3"], fps: 10 }, once: { slices: ["run_0", "run_1", "run_2", "run_3"], fps: 10, loop: false } },
};

// rig.png (64 × 32, 16 px a unit). `body` holds the skeleton: `root` at its left middle, `arm` 16 px to the right.
// Its mesh: the left half on `root`, the right half's far edge on `arm`. `arm` (another slice) shares the skeleton: its
// own `arm` bone at its left middle, every vertex on it.
const BONES = [
  { name: "root", position: [0, 8], length: 16 },
  { name: "arm", parent: "root", position: [16, 0], length: 16 },
];
const RIG = {
  format: "myco.import@1",
  pixelsPerUnit: 16,
  sprites: [
    {
      name: "body",
      rect: [0, 0, 32, 16],
      pivot: [0, 0],
      skin: {
        bones: BONES,
        mesh: { vertices: [0, 0, 16, 0, 32, 0, 32, 16, 16, 16, 0, 16], triangles: [0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4] },
        weights: [[0, 1], [0, 1], [1, 1], [1, 1], [0, 1], [0, 1]],
      },
    },
    {
      name: "arm",
      rect: [32, 0, 16, 16],
      pivot: [0, 0],
      skin: { bones: [{ name: "arm", position: [0, 8], length: 16 }], mesh: { vertices: [0, 0, 16, 0, 16, 16, 0, 16], triangles: [0, 1, 2, 0, 2, 3] }, weights: [[0, 1], [0, 1], [0, 1], [0, 1]] },
      outline: [[[0, 0], [16, 0], [16, 16], [0, 16]]], // ADR 0415: shadow casters follow it as the bones bend it
    },
    { name: "plain", rect: [48, 0, 16, 16] },
  ],
};

/** The `arm` bone turned 90° (constant over 1 s), as a raw clip for the rig's skeleton. */
function bendClip(): string {
  const model = skeleton2D(BONES.map((b) => ({ name: b.name, parent: b.parent ?? null, position: b.position as [number, number], rotation: 0, length: b.length })), sliceFrame({ rect: [0, 0, 32, 16], pivot: [0, 0] }, 16, 100));
  const s = Math.SQRT1_2;
  const { bytes } = writeRawClip({ name: "bend", rate: 30, duration: 1, loop: true, tracks: [{ kind: "bone", bone: "arm", translation: [], rotation: [[0, 0, 0, s, s]], scale: [] }], skeleton: model.skeleton });
  return `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "sheet.png": "data:,",
      "sheet.png.meta.json": SHEET,
      "rig.png": "data:,",
      "rig.png.meta.json": RIG,
      "rig/bend.anim": bendClip(),
    }),
  );
  engine = await Engine.create({ headless: true, project: { render: RENDER } });
});

afterEach(() => {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
});

afterAll(() => engine?.dispose());

/** Plays `clip` and steps with dt 0 until it shows (loaded and sent): no time passes. */
async function start(anim: Animator, clip: string): Promise<void> {
  anim.play(clip);
  await vi.waitFor(() => {
    engine.step(0);
    expect(anim.state().name).toBe(clip);
  });
}

describe("flipbooks (ADR 0371)", () => {
  it("SpriteRenderer.sprite is animatable", () => {
    expect(isFieldAnimatable(SpriteRenderer, "sprite")).toBe(true);
  });

  for (const loop of [true, false]) {
    it(`step the sprite through the slices on an Animator without a skeleton (loop ${loop})`, async () => {
      const node = GameObject.create("Runner");
      made.push(node);
      const sprite = node.addComponent(SpriteRenderer, { sprite: "sheet.png#run_3" });
      const anim = node.addComponent(Animator);
      await start(anim, loop ? "sheet.png#Flip/run" : "sheet.png#Flip/once");
      expect(sprite.sprite).toBe("sheet.png#run_0");
      const seen: string[] = [];
      engine.step(0.05);
      for (let i = 0; i < 5; i++) {
        engine.step(0.1); // t = 0.15, 0.25, 0.35, 0.45, 0.55
        seen.push(sprite.sprite);
      }
      expect(seen).toEqual(loop ? ["sheet.png#run_1", "sheet.png#run_2", "sheet.png#run_3", "sheet.png#run_0", "sheet.png#run_1"] : ["sheet.png#run_1", "sheet.png#run_2", "sheet.png#run_3", "sheet.png#run_3", "sheet.png#run_3"]);
    });
  }

  it("a flipbook the sidecar lacks ends at once with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = GameObject.create("Runner");
    made.push(node);
    node.addComponent(SpriteRenderer, { sprite: "sheet.png#run_2" });
    const anim = node.addComponent(Animator);
    anim.play("sheet.png#Flip/walk");
    await vi.waitFor(() => {
      engine.step(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('couldn\'t load the clip "sheet.png#Flip/walk"'))).toBe(true);
    });
    warn.mockRestore();
  });
});

// --- skinned sprites --------------------------------------------------------------------------------------------------

const fakeHost = () => memoryQuadHost();

/** xy per vertex of a batch's positions (z checked 0). */
function xy(b: MemoryQuadBatch): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < b.positions.length; i += 3) {
    expect(b.positions[i + 2]).toBe(0);
    out.push([b.positions[i]!, b.positions[i + 1]!]);
  }
  return out;
}

function expectPoints(actual: [number, number][], expected: [number, number][]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(expected[i]![0], 4);
    expect(y).toBeCloseTo(expected[i]![1], 4);
  });
}

interface Rig {
  root: GameObject;
  body: SpriteRenderer;
  arm: SpriteRenderer;
  plain: SpriteRenderer;
}

function rig(withAnimator: boolean): Rig {
  const root = GameObject.create("Rig");
  made.push(root);
  root.transform!.position = [5, 0, 0];
  root.addComponent(Skeleton2D, { bones: "asset:rig.png#body" });
  if (withAnimator) root.addComponent(Animator);
  const child = (name: string, sprite: string) => GameObject.create(name, { parent: root }).addComponent(SpriteRenderer, { sprite });
  return { root, body: child("Body", "rig.png#body"), arm: child("Arm", "rig.png#arm"), plain: child("Plain", "rig.png#plain") };
}

describe("Skeleton2D and skinned sprites (ADR 0370, 0371)", () => {
  // Rest positions in the skeleton's units (pivot at the body's bottom left, 16 px a unit): the body's mesh as is, the
  // arm slice moved so its bone lies on the skeleton's `arm` (one unit right).
  const BODY_REST: [number, number][] = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1]];
  const ARM_REST: [number, number][] = [[1, 0], [2, 0], [2, 1], [1, 1]];
  // `arm` turned 90° counter-clockwise about its joint (1, 0.5).
  const turn = ([x, y]: [number, number]): [number, number] => [1 - (y - 0.5), 0.5 + (x - 1)];

  it("claims only skinned slices under a Skeleton2D, and draws the bind pose before any clip", () => {
    const r = rig(false);
    expect(claimsSkinnedSprite(r.body)).toBe(true);
    expect(claimsSkinnedSprite(r.plain)).toBe(false);
    const loose = GameObject.create("Loose").addComponent(SpriteRenderer, { sprite: "rig.png#body" });
    made.push(loose.node);
    expect(claimsSkinnedSprite(loose)).toBe(false);
    const { host, batches } = fakeHost();
    const sprites = new SkinnedSprites(host);
    sprites.sync(engine.world);
    expect(batches).toHaveLength(2);
    const [body, arm] = batches as [MemoryQuadBatch, MemoryQuadBatch];
    expect(body.texture).toBe("rig.png");
    expectPoints(xy(body), BODY_REST);
    expectPoints(xy(arm), ARM_REST);
    expect(body.matrix[12]).toBe(5); // placed by the Skeleton2D's node
    expect([...sprites.drawn()].map((d) => d.renderer)).toEqual([r.body, r.arm]);
    expectPoints(sprites.deformedOutline(r.arm)![0]!, ARM_REST); // ADR 0415: the outline at rest, in the arm node's space
    expect(sprites.deformedOutline(r.body)).toBeNull(); // no outline on the body's slice
    sprites.dispose();
    expect(batches.every((b) => b.disposed)).toBe(true);
  });

  it("an Animator's bone track poses the skeleton, deforming both slices that share it", async () => {
    const r = rig(true);
    await vi.waitFor(() => expect(instanceForSkeleton(engine.world, r.root)).not.toBe(0));
    const anim = r.root.getComponent(Animator)!;
    await start(anim, "rig/bend.anim");
    engine.step(1 / 30);
    const { host, batches } = fakeHost();
    const sprites = new SkinnedSprites(host);
    sprites.sync(engine.world);
    const [body, arm] = batches as [MemoryQuadBatch, MemoryQuadBatch];
    expectPoints(xy(body), BODY_REST.map((p, i) => (i === 2 || i === 3 ? turn(p) : p)));
    expectPoints(xy(arm), ARM_REST.map(turn));
    expectPoints(sprites.deformedOutline(r.arm)![0]!, ARM_REST.map(turn)); // ADR 0415: the outline bends with the bone

    // An unchanged pose skins nothing; stopping returns to the bind pose.
    const sets = body.sets;
    sprites.sync(engine.world);
    expect(body.sets).toBe(sets);
    anim.stop();
    engine.step(1 / 30);
    sprites.sync(engine.world);
    expectPoints(xy(body), BODY_REST);

    // A sprite that leaves the skeleton is released.
    r.arm.node.setParent(engine.world.root);
    made.push(r.arm.node);
    sprites.sync(engine.world);
    expect(arm.disposed).toBe(true);
    sprites.dispose();
  });

  it("places skinned sprites of a y-sorted layer by their nodes' heights within their order in layer, lower on top (ADR 0440)", () => {
    const r = rig(false);
    for (const s of [r.body, r.arm]) Object.assign(s, { sortingLayer: "Units", orderInLayer: 4 });
    r.body.node.transform!.position.y = 1;
    r.arm.node.transform!.position.y = -2; // below the body: drawn over it
    const { host, batches } = fakeHost();
    const sprites = new SkinnedSprites(host);
    sprites.sync(engine.world);
    const [body, arm] = batches as [MemoryQuadBatch, MemoryQuadBatch];
    expect([body.sortingLayer, body.place]).toEqual(["Units", drawPlace(RENDER, "Units", 4, 1)]);
    expect(arm.place).toBe(drawPlace(RENDER, "Units", 4, -2));
    const order = () => new Map([...sprites.drawn()].map((d) => [d.renderer, d.batches[0]!.place])); // what picking ranks each by: its batch's place
    let drawn = order();
    expect(drawn.get(r.body)).toBe(drawPlace(RENDER, "Units", 4, 1));
    expect(drawn.get(r.arm)).toBe(drawPlace(RENDER, "Units", 4, -2));
    for (const o of drawn.values()) expect(o >= 10004 && o < 10005).toBe(true);
    expect(drawn.get(r.arm)!).toBeGreaterThan(drawn.get(r.body)!);

    // The sort point is the sprite's node (not the skeleton's): moving the arm above the body puts it under.
    r.arm.node.transform!.position.y = 3;
    sprites.sync(engine.world);
    expect(arm.place).toBe(drawPlace(RENDER, "Units", 4, 3));
    drawn = order();
    expect(drawn.get(r.arm)).toBe(drawPlace(RENDER, "Units", 4, 3));
    expect(drawn.get(r.arm)!).toBeLessThan(drawn.get(r.body)!);

    // A layer that isn't y-sorted: the order alone, whatever the height.
    for (const s of [r.body, r.arm]) s.sortingLayer = "Default";
    sprites.sync(engine.world);
    expect([body.sortingLayer, body.place, arm.place]).toEqual(["Default", 4, 4]);
    expect([...order().values()]).toEqual([4, 4]);
    sprites.dispose();
  });
});
