// A flipbook made from slices by the editor's logic plays through the runtime (ADR 0371, 0373; T56): the sidecar the Sprite
// Editor would write (`createFlipbook`, edits, `formatImportSettings`) is served to a headless Engine through the public API
// (`myco`), and an Animator steps `SpriteRenderer.sprite` through the slices in the frames' order, a held frame lasting
// its hold. Time comes from `engine.step(dt)` only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, SpriteRenderer } from "../../../../myco";
import { defaultImportSettings, formatImportSettings } from "../../../../engine/scene/importSettings";
import { createFlipbook, editFlipbook, setHold, setLoop } from "./flipbookLogic";

let engine: Engine;
const made: GameObject[] = [];

const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

// Slices selected out of order; run_10 sorts after run_2 by number. The flipbook is made, its run_1 held for two entries and
// a second one set not to loop, then written as the sidecar the editor writes.
const NAMES = ["run_0", "run_1", "run_2", "run_10"];
function sidecar(): string {
  let flipbooks = ok(createFlipbook({}, NAMES, ["run_10", "run_2", "run_0", "run_1"], { fps: 10 })).flipbooks;
  flipbooks = ok(editFlipbook(flipbooks, "run", (f) => setHold(f, 1, 2)));
  flipbooks = ok(createFlipbook(flipbooks, NAMES, NAMES, { name: "once", fps: 10 })).flipbooks;
  flipbooks = ok(editFlipbook(flipbooks, "once", (f) => setLoop(f, false)));
  return formatImportSettings({
    ...defaultImportSettings(),
    sprites: NAMES.map((name, i) => ({ name, rect: [i * 16, 0, 16, 16] as [number, number, number, number], pivot: [0.5, 0] as [number, number] })),
    flipbooks: { ...flipbooks },
  });
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "sheet.png": "data:,", "sheet.png.meta.json": JSON.parse(sidecar()) }));
  engine = await Engine.create({ headless: true });
});
afterEach(() => {
  for (const n of made.splice(0)) if (n.isValid) GameObject.destroy(n);
  engine.step(0);
});
afterAll(() => engine?.dispose());

async function play(clip: string): Promise<SpriteRenderer> {
  const node = GameObject.create("Runner");
  made.push(node);
  const sprite = node.addComponent(SpriteRenderer, { sprite: "sheet.png#run_10" });
  const anim = node.addComponent(Animator);
  anim.play(clip);
  await vi.waitFor(() => {
    engine.step(0);
    expect(anim.state().name).toBe(clip);
  });
  return sprite;
}

/** The sprite after each of `steps` of dt, the first step landing at `first`. */
function sample(sprite: SpriteRenderer, first: number, dt: number, steps: number): string[] {
  const seen: string[] = [];
  engine.step(first);
  seen.push(sprite.sprite);
  for (let i = 1; i < steps; i++) {
    engine.step(dt);
    seen.push(sprite.sprite);
  }
  return seen;
}

describe("a flipbook the editor made", () => {
  it("is a sub-asset clip the Animator plays, frames by name and number with holds, looping", async () => {
    const sprite = await play("sheet.png#Flip/run");
    expect(sprite.sprite).toBe("sheet.png#run_0");
    // Entries: run_0, run_1, run_1, run_2, run_10 at 10 per second, sampled mid-entry (t = 0.05, 0.15 … 0.55).
    expect(sample(sprite, 0.05, 0.1, 6)).toEqual(["sheet.png#run_0", "sheet.png#run_1", "sheet.png#run_1", "sheet.png#run_2", "sheet.png#run_10", "sheet.png#run_0"]);
  });

  it("holds the last frame when it doesn't loop", async () => {
    const sprite = await play("sheet.png#Flip/once");
    expect(sample(sprite, 0.05, 0.1, 6)).toEqual(["sheet.png#run_0", "sheet.png#run_1", "sheet.png#run_2", "sheet.png#run_10", "sheet.png#run_10", "sheet.png#run_10"]);
  });
});
