import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Assets, Engine, NavAgent, NavGroup, SceneManager, type ProjectSettingsInput } from "../index";
import { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { bakeChunk, releaseBakeCaches, type NavBakeMesh } from "../nav/bake";
import {
  FORMATION_FORMAT,
  clearFormation,
  defaultFormation,
  fillFormation,
  formatFormation,
  formationCell,
  formationFillOrder,
  formationFromPixels,
  formationImportSize,
  formationMask,
  formationSlotCount,
  invertFormation,
  mirrorFormation,
  parseFormation,
  resizeFormation,
  setFormationCell,
  type NavFormationAsset,
} from "../nav/formation";
import { clearNavBakeCache } from "../nav/navigationSystems";
import {
  binColor,
  chunkBakesAgentType,
  classifySurfaceBins,
  describeNavBakePlan,
  describeSurfaceBins,
  flightBaseCell,
  invertAffine,
  leavesInBox,
  navBakePlan,
  resolutionRegionEffects,
  resolutionRegionLevel,
  surfaceBinLayout,
} from "../nav/plan";
import { defaultNavAgentType, defaultNavigationSettings, type NavigationSettings } from "../nav/settings";

// ADR 0065: formation assets (Foxfire's NavFormation), and the bake plan / bins helpers behind the editor's
// navigation inspectors (Foxfire's custom editors).

/** A formation from row strings. */
function rows(lines: string[], shape: NavFormationAsset["shape"] = "mask"): NavFormationAsset {
  return parseFormation({ format: FORMATION_FORMAT, shape, width: lines[0].length, height: lines.length, cells: lines }).formation;
}
const text = (f: NavFormationAsset) => formatFormation(f).match(/"cells": \[([^\]]*)\]/)![1].replace(/[\s"]/g, "").split(",");

describe("formation assets", () => {
  it("parses rows and bit strings, reports bad values and writes rows back", () => {
    const f = rows(["#..", ".#.", "..#"]);
    expect(f.width).toBe(3);
    expect(formationCell(f, 0, 0)).toBe(true);
    expect(formationCell(f, 1, 0)).toBe(false);
    expect(formationCell(f, 2, 2)).toBe(true);
    expect(text(f)).toEqual(["#..", ".#.", "..#"]);
    const bits = parseFormation({ width: 2, height: 2, cells: "1001" }).formation;
    expect(bits.cells).toEqual([true, false, false, true]);
    const bad = parseFormation({ format: "x", shape: "blob", width: 500, layers: 20, layerSpacing: -1 }, "f.formation.json");
    expect(bad.formation.width).toBe(128);
    expect(bad.formation.shape).toBe("mask");
    expect(bad.formation.layers).toBe(8);
    expect(bad.formation.layerSpacing).toBe(0);
    expect(bad.problems.length).toBe(3);
    expect(() => parseFormation([])).toThrow();
    const d = defaultFormation();
    expect([d.shape, d.width, d.height, d.layers, d.layerSpacing, formationSlotCount(d)]).toEqual(["mask", 16, 16, 1, 0, 0]);
    expect(parseFormation(formatFormation(f)).formation).toEqual(f);
  });

  it("resizes keeping the painted cells that still fit, clamped to 1-128", () => {
    const f = rows(["##.", "#.#"]);
    const big = resizeFormation(f, 5, 3);
    expect(text(big)).toEqual(["##...", "#.#..", "....."]);
    const small = resizeFormation(f, 2, 1);
    expect(text(small)).toEqual(["##"]);
    const clamped = resizeFormation(f, 0, 999);
    expect([clamped.width, clamped.height]).toEqual([1, 128]);
  });

  it("paints, clears, fills, inverts and mirrors (the left half onto the right)", () => {
    let f = rows(["....", "...."]);
    f = setFormationCell(f, 1, 0, true);
    expect(setFormationCell(f, 1, 0, true)).toBe(f);
    expect(setFormationCell(f, 9, 0, true)).toBe(f);
    expect(text(f)).toEqual([".#..", "...."]);
    expect(text(invertFormation(f))).toEqual(["#.##", "####"]);
    expect(formationSlotCount(fillFormation(f))).toBe(8);
    expect(formationSlotCount(clearFormation(f))).toBe(0);
    expect(text(mirrorFormation(rows(["#...", ".#.#"])))).toEqual(["#..#", ".##."]);
    expect(text(mirrorFormation(rows(["#.#..", "....."])))).toEqual(["#.#.#", "....."]);
  });

  it("numbers slots front row first, from the middle out, right before left (nav-crowd's create_mask)", () => {
    const f = rows(["#####", ".###.", "..#.."]);
    const order = formationFillOrder(f).map((i) => [i % 5, Math.floor(i / 5)]);
    expect(order).toEqual([
      [2, 0], [3, 0], [1, 0], [4, 0], [0, 0],
      [2, 1], [3, 1], [1, 1],
      [2, 2],
    ]);
    // An even span: the centre is between columns 1 and 2, so 2 (right) goes first.
    expect(formationFillOrder(rows(["####"]))).toEqual([2, 1, 3, 0]);
    // Painted off to one side: the middle of the painted columns, not of the grid.
    expect(formationFillOrder(rows([".....##"]))).toEqual([6, 5]);
  });

  it("imports pixels by threshold, alpha or luminance, and sizes to the image", () => {
    const f = defaultFormation();
    // 2 × 2 RGBA: white opaque, black opaque, white transparent, grey half alpha.
    const px = [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 0, 128, 128, 128, 128];
    const byAlpha = formationFromPixels(f, px, 2, 2, 0.5, true);
    expect([byAlpha.width, byAlpha.height]).toEqual([2, 2]);
    expect(byAlpha.cells).toEqual([true, true, false, true]);
    const byLuma = formationFromPixels(f, px, 2, 2, 0.6, false);
    expect(byLuma.cells).toEqual([true, false, true, false]);
    expect(formationFromPixels(f, px, 2, 2, 0, true).cells.every(Boolean)).toBe(true);
    expect(formationImportSize(f, 512, 256, true)).toEqual([128, 64]);
    expect(formationImportSize(f, 20, 10, true)).toEqual([20, 10]);
    expect(formationImportSize(f, 512, 256, false)).toEqual([16, 16]);
  });

  it("gives the runtime a mask only for the Mask shape", () => {
    expect(formationMask(rows(["#"], "wedge"))).toBeNull();
    expect(formationMask(rows(["#."]))).toEqual({ bits: [true, false], width: 2, height: 1 });
  });
});

describe("bake plan and inspector rules", () => {
  function settings(): NavigationSettings {
    const s = defaultNavigationSettings();
    const small = defaultNavAgentType("small", "Small");
    const twin = defaultNavAgentType("twin", "Twin");
    const big = defaultNavAgentType("big", "Big");
    big.walk.radius = 1.5;
    big.walk.height = 3;
    const bird = defaultNavAgentType("bird", "Bird");
    bird.canWalk = false;
    bird.canFly = true;
    bird.flight.radius = 1;
    s.agentTypes = [small, twin, big, bird];
    return s;
  }
  const floor = { positions: new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
  const geometry = (skip: string[] = [], walkableFor?: string[]) => ({
    meshes: [{ ...floor, walkableFor }],
    chunk: { skipAgents: skip },
    modifierVolumes: [],
    gates: [],
    resolutionVolumes: [],
  });

  it("groups agent types with identical voxel settings, lists flight volumes and skipped types", async () => {
    const plan = await navBakePlan(settings(), geometry(["big"]));
    const byId = Object.fromEntries(plan.agentTypes.map((t) => [t.id, t]));
    expect(byId.small.walkGroup).toBe(0);
    expect(byId.twin.walkGroup).toBe(0);
    expect(byId.big).toMatchObject({ skipped: true, baked: false, walkGroup: -1 });
    expect(byId.bird).toMatchObject({ walkGroup: -1, flyGroup: 0 });
    expect(plan.walkGroups[0].members).toEqual(["small", "twin"]);
    const lines = describeNavBakePlan(plan);
    expect(lines[0]).toMatch(/^Small: navmesh 1 .*shared with Twin\.$/);
    expect(lines[2]).toBe("Big: skipped here (Skip Agents).");
    expect(lines[3]).toMatch(/^Bird: flight volume 1/);
    // A mesh walkable only for Small splits the twins.
    const split = await navBakePlan(settings(), geometry([], ["small"]));
    expect(split.agentTypes.find((t) => t.id === "twin")!.walkGroup).not.toBe(split.agentTypes.find((t) => t.id === "small")!.walkGroup);
  });

  it("applies NavChunkAuthoring.Bakes and the resolution region's cell sizes", () => {
    const s = settings();
    expect(chunkBakesAgentType(s, [], "small")).toBe(true);
    expect(chunkBakesAgentType(s, ["small"], "small")).toBe(false);
    expect(chunkBakesAgentType(s, [], "nobody")).toBe(false);
    const base = flightBaseCell(s, s.agentTypes[3]);
    expect(base).toBeCloseTo(1 / s.flightCellsPerRadius);
    expect(resolutionRegionLevel(1, 0.5)).toBe(1);
    expect(resolutionRegionLevel(1, 0.1)).toBe(3);
    expect(resolutionRegionLevel(1, 0.8)).toBe(0);
    expect(resolutionRegionLevel(1, 0)).toBe(0);
    const effects = resolutionRegionEffects(s, [], base / 4, []);
    expect(effects).toEqual([{ id: "bird", name: "Bird", baseCell: base, level: 2, cell: base / 4 }]);
    expect(resolutionRegionEffects(s, ["bird"], base / 4, [])).toEqual([]);
    expect(resolutionRegionEffects(s, [], base / 4, ["small"])).toEqual([]);
  });

  it("classifies surfaces into the bake's orientation bins", async () => {
    const s = settings();
    const layout = await surfaceBinLayout(s);
    if ("error" in layout) throw new Error(layout.error);
    expect(layout.bins[0].name).toBe("Floor");
    const tris = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, /* wall facing +x */ 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const bins = await classifySurfaceBins(s, tris);
    expect(bins[0]).toBe(0);
    expect(layout.bins[bins[1]].normal[0]).toBeGreaterThan(0.9);
    expect(describeSurfaceBins(layout).summary[0]).toMatch(/^\d+ bins: floor, \d+ side/);
    expect(binColor(0, layout.ceilingBin, 0x00ff00, 0xff00ff)).toBe(0x00ff00);
    expect(binColor(1, layout.ceilingBin, 0x00ff00, 0xff00ff)).not.toBe(binColor(2, layout.ceilingBin, 0x00ff00, 0xff00ff));
  });

  it("keeps flight leaves whose centres are inside an oriented box", () => {
    // A box 2 m wide centred on (10, 0, 0), rotated 90° about y.
    const box = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 10, 0, 0, 1];
    const inv = invertAffine(box)!;
    expect(inv[12] * 1).toBeCloseTo(0, 5); // maps the centre to the origin
    const leaves = new Float32Array([9.5, -0.5, -0.5, 1, 0, /* centre (10,0,0) inside */ 20, 0, 0, 1, 0 /* outside */]);
    expect(Array.from(leavesInBox(leaves, box))).toEqual([9.5, -0.5, -0.5, 1, 0]);
  });
});

// ------------------------------------------------------------------------------------------- a group in a formation

const WALKER = "walker";
const SCENE = "scenes/formation.scene.json";
const BAKE = "scenes/formation.nav.bin";

function walkSettings(): NavigationSettings {
  const s = defaultNavigationSettings();
  s.agentTypes = [defaultNavAgentType(WALKER, "Walker")];
  return s;
}
const project = (): ProjectSettingsInput => ({ navigation: walkSettings() });

function floor(half: number): NavBakeMesh {
  return { positions: new Float32Array([-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
}

let bakeUrl = "";
beforeAll(async () => {
  const baked = await bakeChunk([floor(30)], walkSettings(), SCENE, "chunk");
  bakeUrl = `data:application/octet-stream;base64,${Buffer.from(baked.bytes).toString("base64")}`;
});
afterAll(() => releaseBakeCaches());
const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

function find(name: string): GameObject {
  const walk = (n: GameObject): GameObject | null => {
    if (n.name === name) return n;
    for (const c of n.children) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(World.require().root)!;
}

/** Four agents join a group using `formation` and walk 30 m along +x; returns their final positions. */
async function march(formation: NavFormationAsset): Promise<{ x: number; z: number }[]> {
  clearNavBakeCache();
  Assets.clearSources();
  const members = ["a", "b", "c", "d"];
  Assets.addSource(
    Assets.fromObject({
      "formations/f.formation.json": JSON.parse(formatFormation(formation)),
      [BAKE]: bakeUrl,
      [SCENE]: {
        format: "myco.scene@1",
        nodes: [
          { id: "chunk", name: "Chunk", components: [{ type: "engine.NavChunk", data: { bake: `asset:${BAKE}` } }] },
          {
            id: "group",
            name: "Group",
            components: [{ type: "engine.Transform", data: { position: [-15, 0, 0] } }, { type: "engine.NavGroup", data: { agentType: WALKER, formation: "box", formationAsset: "asset:formations/f.formation.json", spacing: 2 } }],
          },
          ...members.map((id, i) => ({ id, name: id, components: [{ type: "engine.Transform", data: { position: [-15 - i, 0, i - 1.5] } }, { type: "engine.NavAgent", data: { agentType: WALKER } }] })),
        ],
      },
    }),
  );
  const engine = await Engine.create({ headless: true, project: project() });
  engines.push(engine);
  await SceneManager.load(SCENE);
  engine.step(1 / 60);
  const group = find("Group").getComponent(NavGroup)!;
  for (const id of members) group.join(find(id).getComponent(NavAgent)!);
  engine.step(1 / 60);
  group.setDestination([15, 0, 0]);
  for (let i = 0; i < 60 * 25; i++) engine.step(1 / 60);
  return members.map((id) => {
    const p = find(id).transform!.position;
    return { x: p.x, z: p.z };
  });
}

const spread = (v: number[]) => Math.max(...v) - Math.min(...v);

describe("a NavGroup with a formation asset (ADR 0065)", () => {
  it("moves in the asset's shape: a row stands abreast, a column in single file", async () => {
    const row = await march(rows(["####"]));
    expect(spread(row.map((p) => p.x))).toBeLessThan(1.5);
    expect(spread(row.map((p) => p.z))).toBeGreaterThan(4.5);
    expect(Math.min(...row.map((p) => p.x))).toBeGreaterThan(8);

    const column = await march(rows(["#", "#", "#", "#"]));
    expect(spread(column.map((p) => p.z))).toBeLessThan(1.5);
    expect(spread(column.map((p) => p.x))).toBeGreaterThan(4.5);
  }, 60_000);
});
