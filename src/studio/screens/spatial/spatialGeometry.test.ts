import { describe, expect, it } from "vitest";
import type { SceneBox, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { createKeymap } from "../../shell/keymap";
import { INITIAL_SLAB, dragSlabEdge, heightMarks, heightRange, heightTicks, inRange, inSlab, moveSlab, relativeHeight, shiftSpan, sideRange, slabRange } from "./elevation";
import {
  boundsOf, boxContains, boxCorners, boxEdges, boxSpanX, depthIn, growBox, nearestOnBox, insertWaypoint, moveWaypoint, normalizeDeg, projectOnRoute, removeWaypoint, resizeFromEdge, rotateKnob, rotateToward, routeAt, routeMidpoints, snap, toLocal, toWorld,
} from "./geometry";
import { bottomValue, fieldValue, topValue, zoneState } from "./inspectorFields";
import { outlineGroups } from "./outline";
import { SCENE_KEYS, type SceneAction } from "./sceneKeys";
import { fixtureScene } from "./spatialFixture";
import { DEFAULT_VIEW, fitView, gridStep, panBy, pinch, toPlan, toScreen, viewKey, zoomAt } from "./viewTransform";

const box = (over: Partial<SceneBox> = {}): SceneBox => ({ center: { x: 10, y: 0, z: 20 }, width: 8, depth: 4, yaw: 0, bottom: 0, top: 5, ...over });
const close = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
};

describe("rotated boxes", () => {
  it("turns clockwise seen from above, as AudioZone does (local north goes east at 90°)", () => {
    const b = box({ yaw: 90 });
    close(toWorld(b, { x: 0, z: 2 }), { x: 12, z: 20 });
    close(toLocal(b, { x: 12, z: 20 }), { x: 0, z: 2 });
  });

  it("local and world frames are inverses at any turn", () => {
    const b = box({ yaw: -37 });
    const p = { x: 13.2, z: 17.9 };
    close(toWorld(b, toLocal(b, p)), p);
  });

  it("knows what's inside, turned", () => {
    const b = box({ yaw: 90 }); // now 4 wide in x, 8 deep in z
    expect(boxContains(b, { x: 11.9, z: 23.9 })).toBe(true);
    expect(boxContains(b, { x: 13, z: 20 })).toBe(false);
    expect(boxContains(box(), { x: 13, z: 20 })).toBe(true);
  });

  it("has four corners and a knob beyond its north edge", () => {
    const c = boxCorners(box());
    expect(c).toHaveLength(4);
    close(c[0]!, { x: 6, z: 18 });
    close(c[2]!, { x: 14, z: 22 });
    close(rotateKnob(box(), 3), { x: 10, z: 25 });
  });

  it("has a handle at the middle of each edge: south, east, north, west", () => {
    const e = boxEdges(box());
    close(e[0]!, { x: 10, z: 18 });
    close(e[1]!, { x: 14, z: 20 });
    close(e[2]!, { x: 10, z: 22 });
    close(e[3]!, { x: 6, z: 20 });
  });

  it("resizes from an edge: the opposite edge stays put, snapped to 0.5 m, never below 0.5 m", () => {
    const east = resizeFromEdge(box(), 1, { x: 17.2, z: 30 });
    expect(east.width).toBe(11);
    expect(east.depth).toBe(4);
    close(boxEdges(east)[3]!, { x: 6, z: 20 }); // the west edge didn't move
    const north = resizeFromEdge(box(), 2, { x: 0, z: 25 });
    expect(north.depth).toBe(7);
    close(boxEdges(north)[0]!, { x: 10, z: 18 });
    expect(resizeFromEdge(box(), 3, { x: 30, z: 20 }).width).toBe(0.5);
    // Turned 90°: the box's east edge faces south on the plan (local x+ is world z−).
    const turned = resizeFromEdge({ ...box(), yaw: 90 }, 1, { x: 10, z: 12 });
    expect(turned.width).toBe(12);
    close(boxEdges(turned)[3]!, { x: 10, z: 24 });
  });

  it("rotates toward the pointer in 5° steps within -180..180", () => {
    expect(rotateToward(box(), { x: 20, z: 20 }).yaw).toBe(90);
    expect(rotateToward(box(), { x: 10 + Math.sin(0.4), z: 20 + Math.cos(0.4) }).yaw).toBe(25); // 22.9° → 25
    expect(rotateToward(box(), { x: 10, z: 10 }).yaw).toBe(180);
    expect(rotateToward(box(), { x: 0, z: 20 }).yaw).toBe(-90);
    expect(normalizeDeg(270)).toBe(-90);
    expect(normalizeDeg(-180)).toBe(180);
  });

  it("finds the nearest point, grows by a feather, spans along x", () => {
    close(nearestOnBox(box(), { x: 20, z: 21 }), { x: 14, z: 21 });
    close(nearestOnBox(box(), { x: 11, z: 21 }), { x: 11, z: 21 });
    expect(growBox(box(), 2)).toMatchObject({ width: 12, depth: 8 });
    const [a, b] = boxSpanX(box({ yaw: 90 }));
    expect(a).toBeCloseTo(8, 6);
    expect(b).toBeCloseTo(12, 6);
  });

  it("says how deep a point is inside (the zone depth readout)", () => {
    expect(depthIn(box(), { x: 10, z: 20 })).toBe(1);
    expect(depthIn(box(), { x: 10, z: 21 })).toBe(0.5);
    expect(depthIn(box(), { x: 30, z: 20 })).toBe(0);
    expect(depthIn(box(), { x: 10, z: 20, y: 7 })).toBe(0);
  });

  it("snaps without negative zero", () => {
    expect(Object.is(snap(-0.1), 0)).toBe(true);
    expect(snap(2.26)).toBe(2.5);
  });
});

describe("routes", () => {
  const route: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }];

  it("walks by arc length", () => {
    close(routeAt(route, 0.5).point, { x: 10, z: 0 });
    close(routeAt(route, 0.75).point, { x: 10, z: 5 });
    close(routeAt(route, 0.75).direction, { x: 0, z: 1 });
  });

  it("projects a dragged point to the nearest place on the path", () => {
    expect(projectOnRoute(route, { x: 4, z: -3 })).toBeCloseTo(0.2, 6);
    expect(projectOnRoute(route, { x: 14, z: 5 })).toBeCloseTo(0.75, 6);
    expect(projectOnRoute(route, { x: -5, z: -5 })).toBe(0);
  });

  it("inserts at midpoints, removes down to two, moves waypoints (snapped)", () => {
    expect(routeMidpoints(route)).toEqual([{ x: 5, z: 0 }, { x: 10, z: 5 }]);
    const ins = insertWaypoint(route, 1, 64);
    expect("next" in ins && ins.next.map((p) => [p.x, p.z])).toEqual([[0, 0], [10, 0], [10, 5], [10, 10]]);
    expect(insertWaypoint(route, 1, 3)).toEqual({ refused: "a route has at most 3 waypoints" });
    const rem = removeWaypoint(route, 1);
    expect("next" in rem && rem.next).toHaveLength(2);
    expect(removeWaypoint(route.slice(0, 2), 0)).toEqual({ refused: "a route needs at least two waypoints" });
    const mv = moveWaypoint(route, 2, { x: 3.3, z: 7.8 });
    expect("next" in mv && mv.next[2]).toEqual({ x: 3.5, y: 0, z: 8 });
  });

  it("frames points with a least size", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: 5, z: 5 }], 20)).toEqual({ minX: -5, minZ: -5, maxX: 15, maxZ: 15 });
  });
});

describe("the view", () => {
  const size = { width: 800, height: 600 };

  it("maps plan to screen with north up, and back", () => {
    const v = { cx: 10, cz: 20, ppm: 10 };
    expect(toScreen(v, size, { x: 10, z: 20 })).toEqual({ x: 400, y: 300 });
    expect(toScreen(v, size, { x: 11, z: 21 })).toEqual({ x: 410, y: 290 });
    expect(toPlan(v, size, { x: 410, y: 290 })).toEqual({ x: 11, z: 21 });
  });

  it("zooms about the pointer: the point under it stays", () => {
    const v = { cx: 0, cz: 0, ppm: 8 };
    const at = { x: 600, y: 100 };
    const before = toPlan(v, size, at);
    const z = zoomAt(v, size, at, 2);
    expect(z.ppm).toBe(16);
    close(toPlan(z, size, at), before);
    expect(zoomAt({ ...v, ppm: 120 }, size, at, 2)).toEqual({ ...v, ppm: 120 }); // clamped: unchanged
  });

  it("pans the content with the pointer and with arrows (Shift further)", () => {
    const v = panBy(DEFAULT_VIEW, 80, 0);
    expect(v.cx).toBe(-10); // content moved right: the middle shows plan 10 m to the west
    expect(viewKey(DEFAULT_VIEW, size, "panLeft").cx).toBe(-2.5);
    expect(viewKey(DEFAULT_VIEW, size, "panLeft", true).cx).toBe(-10);
    expect(viewKey(DEFAULT_VIEW, size, "panUp").cz).toBe(2.5);
    expect(viewKey(DEFAULT_VIEW, size, "zoomIn").ppm).toBe(10);
  });

  it("fits bounds with a margin, and picks a readable grid", () => {
    const v = fitView({ minX: 0, minZ: 0, maxX: 100, maxZ: 70 }, size);
    expect(v.cx).toBe(50);
    expect(v.cz).toBe(35);
    expect(v.ppm).toBeCloseTo(7.36, 2);
    expect(gridStep(8)).toBe(5);
    expect(gridStep(40)).toBe(1);
    expect(gridStep(1)).toBe(50);
  });

  it("follows a pinch: spread zooms, the midpoint pans", () => {
    const v = pinch(DEFAULT_VIEW, size, [{ x: 300, y: 300 }, { x: 500, y: 300 }], [{ x: 250, y: 300 }, { x: 550, y: 300 }]);
    expect(v.ppm).toBe(12);
  });
});

describe("the elevation slab", () => {
  const scene = fixtureScene();

  it("follows the listener ±3 m, kept inside the scene's heights", () => {
    expect(heightRange(scene)).toEqual([0, 30]);
    expect(slabRange(INITIAL_SLAB, 1.7, [0, 30])).toEqual([0, 6]);
    expect(slabRange(INITIAL_SLAB, 10, [0, 30])).toEqual([7, 13]);
    expect(slabRange(INITIAL_SLAB, 29, [0, 30])).toEqual([24, 30]);
    expect(slabRange({ follow: false, low: 2, high: 9 }, 10, [0, 30])).toEqual([2, 9]);
  });

  it("says what's in range: points and spans that overlap it", () => {
    expect(inSlab([0, 6], 7)).toBe(false);
    expect(inSlab([0, 6], 5, 20)).toBe(true);
    const ids = inRange(scene, [0, 6]).map((m) => m.id);
    expect(ids).toContain("emitter3");
    expect(ids).not.toContain("emitter1"); // the waterfall at 14 m
    expect(ids).not.toContain("obstacle3"); // hidden
    expect(heightMarks(scene).find((m) => m.id === "listener1")).toMatchObject({ point: true, active: true });
  });

  it("moves and resizes by hand (following stops)", () => {
    expect(moveSlab(INITIAL_SLAB, [0, 6], 10, [0, 30])).toEqual({ follow: false, low: 7, high: 13 });
    expect(moveSlab(INITIAL_SLAB, [0, 6], 29, [0, 30])).toEqual({ follow: false, low: 24, high: 30 });
    expect(dragSlabEdge([0, 6], "low", 5.8, [0, 30])).toEqual({ follow: false, low: 5, high: 6 });
    expect(dragSlabEdge([0, 6], "high", 12, [0, 30])).toEqual({ follow: false, low: 0, high: 12 });
  });

  it("labels heights relative to the listener and keeps a bar's thickness", () => {
    expect(relativeHeight(7.7, 1.7)).toBe("↑6 m");
    expect(relativeHeight(0.6, 1.7)).toBe("↓1 m");
    expect(relativeHeight(2.2, 1.7)).toBe("");
    expect(shiftSpan(4, 20, 6)).toEqual([6, 22]);
  });

  it("ticks the strip every 5 m and scales the side view to what's in the scene", () => {
    expect(heightTicks([0, 30])).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(heightTicks([0, 12])).toEqual([0, 5, 10]);
    // The storm front reaches 30 m; a scene of ground-level things gets a short range (not squeezed to the bottom).
    expect(sideRange(scene, [0, 6])).toEqual([0, 35]);
    const low = { ...scene, emitters: [], obstacles: [], reverbZones: [], audioZones: [] };
    expect(sideRange(low, [0, 6])).toEqual([0, 10]);
    expect(sideRange(low, [0, 14])).toEqual([0, 20]);
  });
});

describe("the outline", () => {
  it("lists only kinds the scene has", () => {
    const s = { ...fixtureScene(), sounds2d: [] };
    expect(outlineGroups(s).map((g) => g.kind)).not.toContain("sound2d");
  });

  it("groups alphabetically with counts, filters by name or group", () => {
    const g = outlineGroups(fixtureScene());
    expect(g.map((x) => `${x.title} ${x.count}`)).toEqual(["2D sounds 1", "Audio zones 2", "Emitters 4", "Listeners 2", "Obstacles 3", "Reverb zones 1"]);
    expect(g.find((x) => x.kind === "listener")!.rows[0]).toMatchObject({ name: "Player 1", active: true });
    expect(g.find((x) => x.kind === "emitter")!.rows.find((r) => r.name === "Drone")!.moving).toBe(true);
    const f = outlineGroups(fixtureScene(), "camp");
    expect(f.map((x) => x.rows.map((r) => r.name))).toEqual([["Campfire"]]);
    expect(outlineGroups(fixtureScene(), "obstacles")[0]!.rows).toHaveLength(3);
  });
});

describe("an audio zone's state line", () => {
  const s = fixtureScene();
  const wind = s.audioZones[0]!, storm = s.audioZones[1]!;
  it("says where the listener hears it from", () => {
    expect(zoneState(wind, { x: 50, y: 1.7, z: 35 })).toBe("Heard from its nearest edge, 20 m away");
    expect(zoneState(wind, { x: 25, y: 10, z: 12 })).toBe("Listener inside: surrounds you");
    expect(zoneState(storm, { x: 50, y: 1.7, z: 5 })).toBe("Listener inside: playing at full level");
    expect(zoneState(storm, { x: 50, y: 1.7, z: 13 })).toBe("In the feather: fading, 50%");
    expect(zoneState(storm, { x: 50, y: 1.7, z: 35 })).toBe("Listener outside: silent");
  });
});

describe("inspector fields", () => {
  it("clamps to the format's limits, refuses what isn't a number, rounds whole fields", () => {
    expect(fieldValue("volume", "40")).toEqual({ next: 12 });
    expect(fieldValue("volume", "-3,5")).toEqual({ next: -3.5 });
    expect(fieldValue("volume", "loud")).toEqual({ refused: "Volume is a number of dB" });
    expect(fieldValue("volume", " ")).toEqual({ refused: "Volume needs a value" });
    expect(fieldValue("priority", 0)).toEqual({ next: 1 });
    expect(fieldValue("priority", 2.6)).toEqual({ next: 3 });
  });

  it("keeps a box's bottom at least 0.5 m below its top", () => {
    expect(bottomValue("9.6", 10)).toEqual({ refused: "the bottom must be at least 0.5 m below the top" });
    expect(bottomValue("9.5", 10)).toEqual({ next: 9.5 });
    expect(topValue("2", 2)).toEqual({ refused: "the bottom must be at least 0.5 m below the top" });
  });
});

describe("scene keys", () => {
  it("resolve through the Studio's keymap in the Scene panel only", () => {
    const keymap = createKeymap();
    const ran: SceneAction[] = [];
    for (const k of SCENE_KEYS) keymap.register({ id: k.id, keys: k.keys, label: k.label, scope: { panel: "spatial-scene" }, run: () => void ran.push(k.action) });
    const ctx = { screen: "spatial" as const, panels: ["spatial-scene"], singleKeys: true, typing: false, mac: false };
    const press = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, c = ctx) =>
      keymap.handle({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }, c);
    expect(press("c", { ctrlKey: true })).toBe(true);
    expect(press("d", { ctrlKey: true })).toBe(true);
    expect(press("Delete")).toBe(true);
    expect(press("ArrowLeft", { shiftKey: true })).toBe(true);
    expect(press("+", { shiftKey: true })).toBe(true);
    expect(press("0")).toBe(true);
    expect(press("Escape")).toBe(true);
    expect(ran).toEqual([{ kind: "copy" }, { kind: "duplicate" }, { kind: "delete" }, { kind: "view", key: "panLeft", big: true }, { kind: "view", key: "zoomIn", big: false }, { kind: "reset" }, { kind: "escape" }]);
    expect(press("Delete", {}, { ...ctx, panels: [] })).toBe(false); // outside the Scene panel
    expect(press("Delete", {}, { ...ctx, typing: true })).toBe(false); // in a field
    expect(new Set(SCENE_KEYS.map((k) => k.id)).size).toBe(SCENE_KEYS.length);
  });
});
