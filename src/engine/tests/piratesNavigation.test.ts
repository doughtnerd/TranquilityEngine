import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Navigation, Replicated } from "../../myco";
import { World } from "../core/World";
import { releaseBakeCaches } from "../nav/bake";
import { clearNavBakeCache } from "../../plugins/navigation/runtime/navigationSystems";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { CLOUD_PREFAB, Cloud, FlagState, Fx, SHIP_PREFAB, SHIP_RADIUS, Ship, bearing, headingRotation, type CloudView, type FlagView, type ShipView } from "../../../samples/pirates/scripts/data";
import { obstacleList } from "../../../samples/pirates/scripts/systems";
import "../../../samples/pirates/scripts/client";
import "../../../samples/pirates/scripts/bots";
import "../../../samples/pirates/scripts/rules";
import "../../../samples/pirates/scripts/weather";
import { SHIP_AGENT, botPath, navStats } from "../../../samples/pirates/scripts/navigation";
import { Actors } from "../../../samples/pirates/scripts/behaviors/Actors";
import "../../../samples/pirates/scripts/behaviors/Bolt";
import "../../../samples/pirates/scripts/behaviors/Splash";
import "../../../samples/pirates/scripts/behaviors/FollowCamera";
import "../../../samples/pirates/scripts/behaviors/Hud";

// King of Pirates' bots on the arenas' baked navmeshes (samples/pirates/scripts/navigation.ts): each arena loads its
// bake on the server World, a lone bot ship sails round an obstacle to the flag on its far side without touching
// it, and a ghost ship's fog cloud (its NavCostVolume) turns paths and bots aside.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const STEP = 1 / 60;

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});
afterAll(() => releaseBakeCaches());

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A server World alone (no client, so no ships spawn by themselves) on one arena, its navigation loaded. */
async function arena(scene: string): Promise<{ engine: Engine; server: World }> {
  const project = await readProject(SAMPLE);
  clearNavBakeCache();
  Assets.addSource(project.assets);
  const settings = { ...project.settings, bootstrap: { worlds: [{ name: "Server", tags: ["server"], renders: false, input: false, scenes: [`scenes/${scene}.scene.json`] }] } };
  const engine = await Engine.create({ headless: true, project: settings });
  engines.push(engine);
  const server = engine._world("Server")!;
  for (let i = 0; i < 200 && !World._runIn(server, () => Navigation.loadedChunks.length > 0); i++) {
    engine.step(STEP);
    await settle();
  }
  expect(World._runIn(server, () => Navigation.loadedChunks)).toHaveLength(1);
  return { engine, server };
}

function shipIn(server: World): { node: GameObject; data: ShipView } | null {
  for (const r of server._componentsOfType(Replicated)) if (r.node.isValid && r.node.hasData(Ship)) return { node: r.node, data: r.node.getData(Ship) as ShipView };
  return null;
}

function flagIn(server: World): { node: GameObject; data: FlagView } {
  for (const r of server._componentsOfType(Replicated)) if (r.node.isValid && r.node.hasData(FlagState)) return { node: r.node, data: r.node.getData(FlagState) as FlagView };
  throw new Error("no flag");
}

/** Spawns one bot, lets the match start (which puts it on its spawn point), then moves it to `from` facing `to` and the flag to `to`. */
async function botAt(engine: Engine, server: World, from: [number, number], to: [number, number]): Promise<{ node: GameObject; data: ShipView }> {
  World._runIn(server, () => {
    const actors = GameObject.findObjectOfType(Actors)!.node;
    const node = GameObject.instantiate(SHIP_PREFAB, { parent: actors });
    const ship = node.getData(Ship) as ShipView;
    ship.team = 0;
    ship.bot = 1;
  });
  for (let i = 0; i < 3; i++) {
    engine.step(STEP);
    await settle();
  }
  const ship = shipIn(server)!;
  const heading = bearing(from[0], from[1], to[0], to[1]);
  ship.node.transform!.position.set(from[0], 0, from[1]);
  ship.node.transform!.rotation = headingRotation(heading);
  ship.data.heading = heading;
  ship.data.speed = 0;
  ship.data.invulnerable = 0;
  const flag = flagIn(server);
  flag.data.carrier = -1;
  flag.data.cooldown = 0;
  flag.node.transform!.position.set(to[0], 0, to[1]);
  return ship;
}

/**
 * Sails until the bot takes the flag (it sails within 3 m of it) or time runs out; returns the seconds it took
 * (Infinity if it didn't), the closest it came to any obstacle (ship's edge to rock's edge) and its track.
 */
async function sail(engine: Engine, server: World, ship: { node: GameObject; data: ShipView }, seconds: number) {
  let closest = Infinity;
  const track: { x: number; z: number }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    engine.step(STEP);
    if (i % 30 === 0) await settle();
    const p = ship.node.transform!.position;
    track.push({ x: p.x, z: p.z });
    for (const o of obstacleList(server)) closest = Math.min(closest, Math.hypot(p.x - o.x, p.z - o.z) - o.r - SHIP_RADIUS);
    if (flagIn(server).data.carrier === 0) return { time: (i + 1) / 60, closest, track };
  }
  return { time: Infinity, closest, track };
}

/** Where the straight line from a to b passes nearest the point c. */
function lineGap(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(a.x + dx * t - c.x, a.z + dz * t - c.z);
}

/** True if (x, z) is inside the square of half-size `half` round (cx, cz). */
const inSquare = (p: { x: number; z: number }, c: { x: number; z: number }, half: number) => Math.abs(p.x - c.x) < half && Math.abs(p.z - c.z) < half;

describe("King of Pirates bots on the navmesh", () => {
  // From one side of an obstacle to the other, straight through it: the island in the bay, the wreck in the open
  // ocean, and a rock of the maze's inner ring.
  const cases: { scene: string; from: [number, number]; to: [number, number]; obstacle: [number, number] }[] = [
    { scene: "island-bay", from: [-16, 10], to: [-16, -34], obstacle: [-16, -12] },
    { scene: "open-ocean", from: [-28, 50], to: [-28, 10], obstacle: [-28, 30] },
    { scene: "rocky-maze", from: [24.7, -8], to: [3.8, -1.2], obstacle: [15.2, -4.9] },
  ];
  for (const c of cases) {
    it(`sails round an obstacle to a goal on its far side in ${c.scene}`, { timeout: 60_000 }, async () => {
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(Fx, "send").mockImplementation(() => {}); // effects go to clients, and this World has none
      const { engine, server } = await arena(c.scene);
      const from = { x: c.from[0], z: c.from[1] }, to = { x: c.to[0], z: c.to[1] };
      const o = obstacleList(server).find((q) => Math.hypot(q.x - c.obstacle[0], q.z - c.obstacle[1]) < 0.5)!;
      expect(o).toBeTruthy();
      expect(lineGap(from, to, o)).toBeLessThan(o.r); // the straight line runs into it
      // Nothing is walkable on or inside the obstacle: the nearest navmesh is a ship's radius out from its circle.
      for (const y of [0, 5]) {
        const near = World._runIn(server, () => Navigation.nearestPoint([o.x, y, o.z], SHIP_AGENT, o.r + 6));
        expect(near).not.toBeNull();
        expect(Math.hypot(near!.point.x - o.x, near!.point.z - o.z)).toBeGreaterThan(o.r + SHIP_RADIUS);
      }

      // The navmesh's path goes round it, clear of the rock.
      const path = World._runIn(server, () => Navigation.findPath([from.x, 0, from.z], [to.x, 0, to.z], SHIP_AGENT));
      expect(path.status).toBe("success");
      for (let i = 0; i + 1 < path.waypoints.length; i++) {
        const a = path.waypoints[i].position, b = path.waypoints[i + 1].position;
        expect(lineGap({ x: a.x, z: a.z }, { x: b.x, z: b.z }, o)).toBeGreaterThan(o.r + SHIP_RADIUS);
      }

      const ship = await botAt(engine, server, c.from, c.to);
      const run = await sail(engine, server, ship, 25);
      expect(run.time).toBeLessThan(25);
      expect(run.closest).toBeGreaterThan(0); // never touched a rock
      expect(ship.data.hp).toBe(100);
      expect(navStats.get(server)!.plans).toBeGreaterThan(0);
      expect(navStats.get(server)!.fallbacks).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  it("goes round a fog cloud's cost volume", { timeout: 60_000 }, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Fx, "send").mockImplementation(() => {});
    const { engine, server } = await arena("open-ocean");
    const from = { x: 0, z: -30 }, to = { x: 0, z: 30 }, centre = { x: 0, z: 0 };
    const find = () => World._runIn(server, () => Navigation.findPath([from.x, 0, from.z], [to.x, 0, to.z], SHIP_AGENT));
    const nearest = (wps: { position: { x: number; z: number } }[]) => {
      let gap = Infinity;
      for (let i = 0; i + 1 < wps.length; i++) gap = Math.min(gap, lineGap(wps[i].position, wps[i + 1].position, centre));
      return gap;
    };

    // Open water: straight across the middle.
    const clear = find();
    expect(clear.status).toBe("success");
    expect(nearest(clear.waypoints)).toBeLessThan(1);

    // A bot heads for the flag beyond the middle (placed first: a match starting clears the clouds).
    const ship = await botAt(engine, server, [from.x, from.z], [to.x, to.z]);

    // A fog cloud (18 × 18 m, 8× the cost) drops in the middle: the path goes round it.
    World._runIn(server, () => {
      const cloud = GameObject.instantiate(CLOUD_PREFAB, { position: [centre.x, 0, centre.z] });
      const data = cloud.getData(Cloud) as CloudView;
      data.team = 5;
      data.life = 1000;
    });
    const round = find();
    expect(round.status).toBe("success");
    expect(nearest(round.waypoints)).toBeGreaterThan(7);

    // And the bot keeps out of the cloud.
    const run = await sail(engine, server, ship, 25);
    expect(run.time).toBeLessThan(25);
    expect(run.track.some((p) => inSquare(p, centre, 6))).toBe(false);
    expect(botPath(server, 0).length).toBeGreaterThan(0);
  });
});
