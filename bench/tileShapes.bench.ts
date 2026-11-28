/**
 * Tile collision shapes after single-cell edits on a big map (ADR 0439's benchmark, extended by ADR 0444).
 * Run: `npx vitest bench --run bench/tileShapes.bench.ts`.
 *
 * A 512 × 512 square map, 30 % of its cells solid at random (seeded). Each round flips one random cell and times:
 * - `collisionShapes("rectangles")` and `collisionShapes("outline")`: the merge (the chunks it touched) plus putting the
 *   map's shapes together;
 * - `collisionCells()` with `collisionShapes("rectangles", { withoutCells: true })`: what voxel colliders read;
 * - one physics step with a ShapeCollider2D on the map (rectangles): what an edit costs the game in all, on Rapier with
 *   voxel colliders (the edited cells set in place, ADR 0444; target under 5 ms) and on the same backend with the
 *   capability hidden (the one compound rebuilt from the shapes, ADR 0439).
 * The first call (every chunk merged, every collider built) is reported separately.
 */
import { afterAll, test } from "vitest";
import { Assets, Engine, GameObject, SceneManager, ShapeCollider2D, Tilemap, physicsBackends, registerPhysicsBackend } from "../src/myco";

const SIZE = 512;
const EDITS = 40;
const rows: string[] = [];

afterAll(() => {
  process.stdout.write("\n| measure | first ms | mean per edit ms | median per edit ms | max per edit ms |\n|---|---|---|---|---|\n");
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
  const median = [...times].sort((a, b) => a - b)[times.length >> 1];
  rows.push(`| ${name} | ${first.toFixed(1)} | ${mean.toFixed(2)} | ${median.toFixed(2)} | ${Math.max(...times).toFixed(2)} |`);
}

/** A World on the 2D backend `backend2d` (the default one when absent) with the benchmark's map, and a seeded edit. */
async function mapWorld(backend2d?: string) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "tiles.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "", collision: "full" }] },
    "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] },
  }));
  const engine = await Engine.create({ headless: true, project: backend2d ? { physics: { backend2d } } : undefined });
  await SceneManager.load("s.json");
  const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
  const rnd = random(423);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (rnd() < 0.3) map.setTile(x, y, 1);
  const edit = () => {
    const x = Math.floor(rnd() * SIZE), y = Math.floor(rnd() * SIZE);
    map.setTile(x, y, map.getTile(x, y) ? 0 : 1);
  };
  return { engine, map, edit };
}

/** One physics step with a ShapeCollider2D on the map, then one after each of `rounds` edits. */
function physicsRounds(engine: Engine, map: Tilemap, edit: () => void, rounds: number, name: string): void {
  map.node.addBehavior(ShapeCollider2D, { mode: "rectangles" });
  const first = timed(() => engine.step(1 / 60));
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    edit();
    times.push(timed(() => engine.step(1 / 60)));
  }
  report(name, first, times);
}

test("512 × 512 map, 30 % solid, single-cell edits", async () => {
  const { engine, map, edit } = await mapWorld();
  for (const mode of ["rectangles", "outline"] as const) {
    const first = timed(() => map.collisionShapes(mode));
    const times: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      edit();
      times.push(timed(() => map.collisionShapes(mode)));
    }
    report(`collisionShapes("${mode}")`, first, times);
  }
  // What the voxel path reads after an edit (ADR 0444): the cells per chunk and the shapes beside them.
  const firstCells = timed(() => {
    map.collisionCells();
    map.collisionShapes("rectangles", { withoutCells: true });
  });
  const cellTimes: number[] = [];
  for (let i = 0; i < EDITS; i++) {
    edit();
    cellTimes.push(timed(() => {
      map.collisionCells();
      map.collisionShapes("rectangles", { withoutCells: true });
    }));
  }
  report(`collisionCells() + collisionShapes("rectangles", { withoutCells })`, firstCells, cellTimes);

  // Rapier with voxel colliders (ADR 0444): the edited chunk's cells set in place.
  physicsRounds(engine, map, edit, EDITS, "physics step after an edit (voxel colliders, ADR 0444)");
  engine.dispose();

  // The same backend without the capability: the one compound rebuilt (ADR 0439's path, kept for such backends).
  const rapier = physicsBackends("2d").find((r) => r.id === "rapier");
  if (!rapier || rapier.dimension !== "2d") return;
  const stop = registerPhysicsBackend({
    id: "rapier-compound",
    dimension: "2d",
    load: async () => {
      const b = await rapier.load();
      return { capabilities: { ...b.capabilities, voxelColliders: false }, createWorld: (o) => b.createWorld(o) };
    },
  });
  try {
    const compound = await mapWorld("rapier-compound");
    physicsRounds(compound.engine, compound.map, compound.edit, 10, "physics step after an edit (one compound rebuilt, no voxel colliders)");
    compound.engine.dispose();
  } finally {
    stop();
  }
}, 600_000);
