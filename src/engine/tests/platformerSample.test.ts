// The platformer sample (ADR 0031, 0103, 0105): its tilemap level loads and plays end to end, headless.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap, TilemapCollider2D } from "../../myco";
import { readProject } from "../../server/project";
import { Player } from "../../../samples/platformer/scripts/behaviors/Player";
import "../../../samples/platformer/scripts/behaviors/CameraFollow";
import { loadTileset } from "../../plugins/tilemaps/runtime/Tilemap";
import { missingBlobMasks } from "../../plugins/tilemaps/runtime/autotile";

const SAMPLE = fileURLToPath(new URL("../../../samples/platformer", import.meta.url));
const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function start() {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  const engine = await Engine.create({ headless: true, project: project.settings });
  engines.push(engine);
  await SceneManager.load("scenes/main.scene.json");
  const player = GameObject.findObjectOfType(Player)!;
  player.useKeyboard = false;
  return { engine, player, map: GameObject.findObjectOfType(Tilemap)! };
}
const run = (engine: Engine, seconds: number, each?: () => void) => {
  for (let i = 0; i < seconds * 60; i++) {
    each?.();
    engine.step(1 / 60);
  }
};

describe("platformer sample", () => {
  it("has a valid tileset whose ground terrain covers every sides-only shape", async () => {
    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    const ts = loadTileset("tiles/platformer.tileset.json")!;
    expect(ts).not.toBeNull();
    const ground = ts.byTerrain.get("Ground")!;
    expect(ground).toHaveLength(16);
    // A sides-only set leaves only corner-dependent blob shapes without an exact tile... none, since corners are wildcards.
    expect(missingBlobMasks(ground)).toEqual([]);
  });

  it("loads the level with two layers and a tile collider", async () => {
    const { map } = await start();
    expect(map.layerCount).toBe(2);
    expect(map.node.getBehavior(TilemapCollider2D)).not.toBeNull();
    expect(map.cellBounds("Ground")!.maxX).toBeGreaterThan(60);
  });

  it("the player stands on the ground, runs right, jumps a gap, collects coins and survives", async () => {
    const { engine, player, map } = await start();
    run(engine, 1);
    const y0 = player.transform.position.y;
    expect(y0).toBeCloseTo(3.43, 1); // standing on the ground's top at y = 3
    expect(player.grounded).toBe(true);
    const coins = [...map.tiles("Ground")].filter((t) => t.id === 18).length;
    // Run right, jumping now and then: over the first gap (x 9..11) and onto the plank at x 13..15.
    player.move = 1;
    let t = 0;
    run(engine, 4, () => {
      if (t++ % 40 === 0) player.jumpQueued = true;
    });
    expect(player.transform.position.x).toBeGreaterThan(14);
    expect(player.transform.position.y).toBeGreaterThan(-5);
    expect(player.coins + [...map.tiles("Ground")].filter((tile) => tile.id === 18).length).toBe(coins);
  });

  it("one-way planks hold the player from above after jumping up through them", async () => {
    const { engine, player } = await start();
    run(engine, 0.5);
    // The plank at y = 4, x 13..15: put the player under it and jump.
    player.transform.position = [14, 3.5, 0];
    run(engine, 0.5);
    player.jumpQueued = true;
    let maxY = -Infinity;
    run(engine, 2, () => (maxY = Math.max(maxY, player.transform.position.y)));
    expect(maxY).toBeGreaterThan(5);
    expect(player.transform.position.y).toBeCloseTo(5.43, 1); // on the plank's top (y = 5)
  });

  it("spikes send the player back to the start", async () => {
    const { engine, player } = await start();
    run(engine, 0.5);
    player.transform.position = [10.5, 1.5, 0]; // above the spikes in the first pit
    run(engine, 1);
    expect(player.transform.position.x).toBeCloseTo(2.5, 0);
  });
});
