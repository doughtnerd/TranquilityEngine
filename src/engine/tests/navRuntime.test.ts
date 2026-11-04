import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bakeChunk, releaseBakeCaches, type NavBakeMesh, type NavBakeResult } from "../nav/bake";
import {
  AGENT_IN_STRIDE,
  AGENT_OUT_STRIDE,
  AGENT_STATE_STRIDE,
  NavigationRuntime,
  NavPathState,
  agentRow,
  chunkIdOf,
  debugBakeLines,
  type Vec3,
} from "../nav/runtime";
import { defaultNavAgentType, defaultNavigationSettings, parseNavigationSettings, type NavigationSettings } from "../nav/settings";

// ADR 0065: the WebAssembly boundary end to end in Node: bake a floor with a box on it, load it into a
// runtime, walk and fly agents through the zero-copy views, and run the one-shot queries.

const WALKER = "walker";
const FLYER = "flyer";

function settings(): NavigationSettings {
  const s = defaultNavigationSettings();
  const flyer = defaultNavAgentType(FLYER, "Flyer");
  flyer.canWalk = false;
  flyer.canFly = true;
  s.agentTypes = [defaultNavAgentType(WALKER, "Walker"), flyer];
  return s;
}

function floor(half: number): NavBakeMesh {
  const positions = new Float32Array([-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half]);
  return { positions, indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
}

/** A closed axis-aligned box, faces wound outward. */
function box(center: Vec3, size: Vec3, kind: NavBakeMesh["kind"]): NavBakeMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [0, 0, 0];
        p[axis] = center[axis] + (sign * size[axis]) / 2;
        p[u] = center[u] + (a * size[u]) / 2;
        p[v] = center[v] + (b * size[v]) / 2;
        positions.push(...p);
      }
      // (u, v) is right-handed with the +axis normal: counter-clockwise faces +axis.
      if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), kind };
}

const SCENE = "scenes/test.scene.json";
const NODE = "root";
let baked: NavBakeResult;
let rt: NavigationRuntime;

beforeAll(async () => {
  baked = await bakeChunk([floor(10), box([0, 1, 0], [2, 2, 2], "obstacle")], settings(), SCENE, NODE);
  rt = await NavigationRuntime.create(settings());
  rt.loadChunk(baked.report.chunkId, baked.bytes);
});

afterAll(() => {
  rt.dispose();
  releaseBakeCaches();
});

function distance(a: ArrayLike<number>, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("navigation bake", () => {
  it("bakes a navmesh for the walker and a flight volume for the flyer", async () => {
    const r = baked.report;
    expect(r.chunkId).toBe(await chunkIdOf(SCENE, NODE));
    expect(r.navmeshes).toHaveLength(1);
    expect(r.navmeshes[0].polys).toBeGreaterThan(0);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0].leaves).toBeGreaterThan(0);
    expect(r.agents.map((a) => a.name)).toEqual(["Walker"]);
    expect(r.flyers.map((a) => a.name)).toEqual(["Flyer"]);
    expect(r.fingerprints.length).toBe(2);
    expect(r.report.triangles).toBe(14);
    expect(baked.bytes.length).toBeGreaterThan(64);
  });

  it("rebakes incrementally to the same bytes", async () => {
    const again = await bakeChunk([floor(10), box([0, 1, 0], [2, 2, 2], "obstacle")], settings(), SCENE, NODE);
    expect(again.report.report.reusedTiles).toBe(again.report.report.tiles);
    expect(again.report.signature).toBe(baked.report.signature);
    expect(Array.from(again.bytes)).toEqual(Array.from(baked.bytes));
  });

  it("warns about triangles that index missing vertices", async () => {
    const broken: NavBakeMesh = { positions: new Float32Array(3), indices: new Uint32Array([0, 1, 2]) };
    const result = await bakeChunk([broken], settings(), SCENE, "broken");
    expect(result.report.warnings.some((w) => /vertex that doesn't exist/.test(w))).toBe(true);
  });
});

describe("navigation runtime", () => {
  it("walks an agent to its destination, read through the zero-copy views", () => {
    const goal: Vec3 = [8, 0, 8];
    const a = rt.addAgent({ agentType: WALKER, position: [-8, 0, -8] });
    rt.setDestination(a, goal);
    const row = agentRow(a);
    let state = NavPathState.None;
    let t = 0;
    for (let i = 0; i < 900 && state !== NavPathState.Arrived; i++) {
      rt.tick(1 / 30, (t += 1 / 30));
      state = rt.views().agentState[row * AGENT_STATE_STRIDE];
    }
    expect(state).toBe(NavPathState.Arrived);
    const out = rt.views().agentsOut.subarray(row * AGENT_OUT_STRIDE, row * AGENT_OUT_STRIDE + 3);
    expect(distance(out, goal)).toBeLessThan(1.5);
    expect(rt.agentState(a)?.pathState).toBe(NavPathState.Arrived);
    expect(rt.drainWarnings()).toEqual([]);
    rt.removeAgent(a);
    rt.tick(1 / 30, (t += 1 / 30));
    expect(rt.isLive(a)).toBe(false);
  });

  it("takes host-written transforms from agentsIn", () => {
    const a = rt.addAgent({ agentType: WALKER, position: [-5, 0, 5] });
    rt.tick(1 / 30, 100);
    const v = rt.views();
    v.agentsIn.set([5, 0, 5], agentRow(a) * AGENT_IN_STRIDE);
    rt.tick(1 / 30, 100.04);
    expect(distance(rt.agentState(a)!.position, [5, 0, 5])).toBeLessThan(0.01);
    rt.removeAgent(a);
    rt.tick(1 / 30, 100.08);
  });

  it("flies a flyer towards its destination", () => {
    const goal: Vec3 = [8, 1.5, 8];
    const f = rt.addAgent({ agentType: FLYER, position: [-8, 1.5, -8] });
    rt.setDestination(f, goal);
    let t = 200;
    for (let i = 0; i < 600 && rt.agentState(f)?.pathState !== NavPathState.Arrived; i++) rt.tick(1 / 30, (t += 1 / 30));
    const s = rt.agentState(f)!;
    expect(distance(s.position, goal)).toBeLessThan(2);
    rt.removeAgent(f);
    rt.tick(1 / 30, (t += 1 / 30));
  });

  it("finds paths around the box, nearest points and surface raycasts", () => {
    const path = rt.findPath(WALKER, [-8, 0, 0], [8, 0, 0]);
    expect(path.status).toBe("success");
    expect(path.waypoints.length).toBeGreaterThanOrEqual(3); // it bends around the box
    expect(distance(path.waypoints[path.waypoints.length - 1].position, [8, 0, 0])).toBeLessThan(0.5);
    expect(path.waypoints.some((w) => Math.abs(w.position[2]) > 1)).toBe(true);
    expect(rt.isReachable(WALKER, [-8, 0, 0], [8, 0, 0])).toBe(true);
    expect(rt.findPath(WALKER, [-8, 0, 0], [50, 0, 0]).status).toBe("none");

    const near = rt.nearestPoint(WALKER, [3, 1, 3], 2);
    expect(near).not.toBeNull();
    expect(Math.abs(near!.point[1])).toBeLessThan(0.3);
    expect(near!.normal[1]).toBeGreaterThan(0.9);
    expect(rt.nearestPoint(WALKER, [3, 10, 3], 2)).toBeNull();

    const blocked = rt.raycast(WALKER, [-8, 0, 0], [8, 0, 0])!;
    expect(blocked.hit).toBe(true);
    expect(blocked.point[0]).toBeLessThan(-1);
    const clear = rt.raycast(WALKER, [-8, 0, 6], [8, 0, 6])!;
    expect(clear.hit).toBe(false);
    expect(clear.t).toBeCloseTo(1, 3);

    const flight = rt.findPath(FLYER, [-8, 1.5, -8], [8, 1.5, 8]);
    expect(flight.status).toBe("success");
    expect(flight.waypoints.length).toBeGreaterThanOrEqual(2);
  });

  it("gives debug geometry from the runtime and straight from the bake", async () => {
    const id = baked.report.chunkId;
    const lines = rt.debugNavmeshLines(id, WALKER);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length % 7).toBe(0);
    expect(rt.debugNavmeshTriangles(id, WALKER).length % 11).toBe(0);
    expect(rt.debugVolumeLeaves(id, FLYER).length).toBeGreaterThan(0);
    expect(rt.debugNavmeshLines("unknown", WALKER).length).toBe(0);
    const fromBake = await debugBakeLines(baked.bytes, 0);
    expect(Array.from(fromBake)).toEqual(Array.from(lines));
  });

  it("rebuilds the views when many agents grow the buffers", () => {
    const before = rt.views();
    const handles = Array.from({ length: 200 }, (_, i) => rt.addAgent({ agentType: WALKER, position: [-9 + (i % 18), 0, -9 + Math.floor(i / 18) * 0.5] }));
    const after = rt.views();
    expect(after.epoch).not.toBe(before.epoch);
    expect(after).not.toBe(before);
    expect(after.agentRows).toBeGreaterThanOrEqual(200);
    expect(after.agentsIn.length).toBe(after.agentRows * AGENT_IN_STRIDE);
    expect(after.agentsOut.length).toBe(after.agentRows * AGENT_OUT_STRIDE);
    // The new views see the rows the runtime wrote when the agents were added.
    const last = agentRow(handles[199]);
    expect(Array.from(after.agentsIn.subarray(last * AGENT_IN_STRIDE, last * AGENT_IN_STRIDE + 3))).toEqual([-9 + (199 % 18), 0, -9 + Math.floor(199 / 18) * 0.5]);
    rt.tick(1 / 30, 300);
    expect(rt.tickStats().agents).toBe(200);
    expect(rt.views()).toBe(rt.views()); // cached while nothing changes
    for (const h of handles) rt.removeAgent(h);
    rt.tick(1 / 30, 300.04);
    expect(rt.tickStats().agents).toBe(0);
  });
});

describe("navigation settings", () => {
  it("defaults, and fills what a section leaves out", () => {
    expect(parseNavigationSettings(undefined)).toEqual({ settings: defaultNavigationSettings(), problems: [] });
    const { settings: s, problems } = parseNavigationSettings({ agentTypes: [{ id: "a", name: "A", walk: { radius: 0.3 } }], tileSize: 32 });
    expect(problems).toEqual([]);
    expect(s.tileSize).toBe(32);
    expect(s.agentTypes).toHaveLength(1);
    expect(s.agentTypes[0].walk.radius).toBe(0.3);
    expect(s.agentTypes[0].walk.height).toBe(defaultNavigationSettings().agentTypes[0].walk.height);
    expect(s.agentTypes[0].avoidance).not.toBeNull();
    expect(s.orientation).toEqual(defaultNavigationSettings().orientation);
  });

  it("reports bad values and keeps the defaults", () => {
    const { settings: s, problems } = parseNavigationSettings({
      voxels: "huge",
      tileSize: 5,
      orientation: { maxFoldDeg: "steep" },
      agentTypes: [{ name: "no id" }, { id: "w", walk: { motion: { ease: "bounce" } }, avoidance: null, mystery: 1 }, { id: "w" }],
      areas: [{ id: "mud", cost: -2 }],
      bogus: true,
    });
    expect(s.voxels).toBe("auto");
    expect(s.tileSize).toBe(64);
    expect(s.orientation.maxFoldDeg).toBe(90);
    expect(s.agentTypes.map((t) => t.id)).toEqual(["w"]);
    expect(s.agentTypes[0].avoidance).toBeNull();
    expect(s.agentTypes[0].walk.motion.ease).toBe("constant");
    expect(s.areas[0].cost).toBe(1);
    const text = problems.join("\n");
    for (const needle of ["voxels", "tileSize", "maxFoldDeg", "needs an id", "ease", "mystery", 'id "w"', "cost", '"bogus"']) expect(text).toContain(needle);
  });

  it("is exactly what the runtime reads", () => {
    const { settings: s } = parseNavigationSettings({ agentTypes: [{ id: "x", walk: { speed: 7 } }] });
    const runtime = NavigationRuntime.createSync(rt.module, s);
    const a = runtime.addAgent({ agentType: "x", position: [0, 0, 0] });
    expect(a).toBeGreaterThanOrEqual(0);
    runtime.dispose();
    expect(runtime.disposed).toBe(true);
    expect(() => runtime.tick(0.1, 0)).toThrow(/dispose/);
  });
});
