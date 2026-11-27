/**
 * Tile collision shapes after single-cell edits on a big map (ADR 0437's benchmark).
 * Run: `npx vitest bench --run bench/tileShapes.bench.ts`.
 *
 * A 512 × 512 square map, 30 % of its cells solid at random (seeded). Each round flips one random cell and times:
 * - `collisionShapes("rectangles")` and `collisionShapes("outline")`: the merge (the chunks it touched) plus putting the
 *   map's shapes together;
 * - one physics step with a ShapeCollider2D on the map (rectangles), which rebuilds the one compound from the shapes:
 *   what an edit costs the game in all.
 * The first call (every chunk merged) is reported separately.
 */
import { afterAll, test } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap, TilemapCollider2D } from "../src/myco";

const SIZE = 512;
const EDITS = 40;
const rows: string[] = [];

afterAll(() => {
  process.stdout.write("\n| measure | first ms | mean per edit ms | max per edit ms |\n|---|---|---|---|\n");
  for (const r of rows) process.stdout.write(`${r}\n`);
});

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timed(f: () => void): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

function report(name: string, first: number, times: number[]): void {
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  rows.push(`| ${name} | ${first.toFixed(1)} | ${mean.toFixed(2)} | ${Math.max(...times).toFixed(2)} |`);
}

test("512 × 512 map, 30 % solid, single-cell edits", async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "tiles.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "", collision: "full" }] },
    "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] },
  }));
  const engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
  const rnd = random(423);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (rnd() < 0.3) map.setTile(x, y, 1);
  const edit = () => {
    const x = Math.floor(rnd() * SIZE), y = Math.floor(rnd() * SIZE);
    map.setTile(x, y, map.getTile(x, y) ? 0 : 1);
  };

  for (const mode of ["rectangles", "outline"] as const) {
    const first = timed(() => map.collisionShapes(mode));
    const times: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      edit();
      times.push(timed(() => map.collisionShapes(mode)));
    }
    report(`collisionShapes("${mode}")`, first, times);
  }

  map.node.addBehavior(TilemapCollider2D, { mode: "rectangles" });
  const first = timed(() => engine.step(1 / 60));
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    edit();
    times.push(timed(() => engine.step(1 / 60)));
  }
  report("physics step after an edit (shapes + compound rebuild)", first, times);
  engine.dispose();
}, 600_000);
