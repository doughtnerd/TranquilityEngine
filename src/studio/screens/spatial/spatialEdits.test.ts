import { describe, expect, it } from "vitest";
import { audioTestSceneToJson, parseAudioTestScene } from "../../../engine/audio/spatial/testScene";
import type { AudioTestScene, MovingEmitter } from "../../../engine/audio/spatial/testSceneTypes";
import { NO_AUDITION, auditionScene, isSilenced, liveUpdate, toggleMute, toggleSolo } from "./audition";
import {
  activeListener, deleteObject, duplicateObject, findObject, framePoints, moveObjectTo, insertRoutePoint, patchEmitter, patchReverbZone, pasteObject, positionOf, removeRoutePoint, renameObject, setActiveListener, setBox, setBoxHeights, setHeight,
  setHidden, setLocked, type EditResult, isGameScenePath, setBaseScene } from "./sceneEdits";
import { fixtureScene } from "./spatialFixture";
import { INITIAL_TOOLS, afterPlace, escape, newObject, pickTool, place, placeLabel, placesByClick } from "./tools";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
/** An edit never writes what the format would drop or repair. */
const valid = (s: AudioTestScene) => {
  const back = parseAudioTestScene(audioTestSceneToJson(s));
  expect(back.problems).toEqual([]);
  expect(back.scene).toEqual(s);
};
const ctx = { slabLow: 0, material: "concrete", buses: ["Master", "Music", "SFX"] };

describe("moving objects", () => {
  it("moves listeners, static emitters and boxes to the snapped point", () => {
    let s = ok(moveObjectTo(fixtureScene(), "listener1", { x: 40.2, z: 30.7 }));
    expect(findObject(s, "listener1")!.obj).toMatchObject({ position: { x: 40, y: 1.7, z: 30.5 } });
    s = ok(moveObjectTo(s, "obstacle1", { x: 60.1, z: 44 }));
    expect((findObject(s, "obstacle1")!.obj as { box: { center: unknown } }).box.center).toEqual({ x: 60, y: 0, z: 44 });
    valid(s);
  });

  it("keeps a moving emitter on its path (its start moves to the nearest point)", () => {
    const s = ok(moveObjectTo(fixtureScene(), "emitter4", { x: 10, z: 30 }));
    const e = findObject(s, "emitter4")!.obj as MovingEmitter;
    expect(e.start).toBe(0);
    expect(positionOf(findObject(s, "emitter4")!)).toEqual({ x: 10, y: 9, z: 40 });
  });

  it("refuses locked objects and 2D sounds", () => {
    expect(refused(moveObjectTo(fixtureScene(), "emitter3", { x: 0, z: 0 }))).toBe("Campfire is locked");
    expect(refused(moveObjectTo(fixtureScene(), "sound1", { x: 0, z: 0 }))).toBe("a 2D sound has no place in the scene");
    expect(refused(moveObjectTo(fixtureScene(), "nope", { x: 0, z: 0 }))).toBe("it isn't in the scene any more");
  });

  it("reshapes boxes and heights within the format's rules", () => {
    const b = (findObject(fixtureScene(), "obstacle2")!.obj as { box: import("../../../engine/audio/spatial/testSceneTypes").SceneBox }).box;
    expect(refused(setBox(fixtureScene(), "obstacle2", { ...b, top: 0.2, bottom: 0 }))).toBe("the bottom must be at least 0.5 m below the top");
    expect(refused(setBox(fixtureScene(), "emitter1", b))).toBe("an emitter has no box");
    expect(refused(setBoxHeights(fixtureScene(), "obstacle2", 3, 3.2))).toBe("the bottom must be at least 0.5 m below the top");
    const s = ok(setBoxHeights(fixtureScene(), "obstacle2", 1, 4));
    expect((findObject(s, "obstacle2")!.obj as { box: { bottom: number; top: number } }).box).toMatchObject({ bottom: 1, top: 4 });
    const h = ok(setHeight(fixtureScene(), "emitter4", 12.34));
    expect((findObject(h, "emitter4")!.obj as MovingEmitter).height).toBe(12.3);
    expect(refused(setHeight(fixtureScene(), "obstacle1", 2))).toBe("an obstacle has no single height");
    valid(s);
  });
});

describe("naming, hiding, locking, deleting", () => {
  it("renames (not to nothing), hides and locks", () => {
    expect(refused(renameObject(fixtureScene(), "emitter1", "  "))).toBe("a name can't be empty");
    let s = ok(renameObject(fixtureScene(), "emitter1", " Falls "));
    expect(findObject(s, "emitter1")!.obj.name).toBe("Falls");
    s = ok(setHidden(s, "emitter1", true));
    s = ok(setLocked(s, "emitter1", true));
    expect(findObject(s, "emitter1")!.obj).toMatchObject({ hidden: true, locked: true });
    expect(ok(setHidden(s, "emitter1", true))).toBe(s);
    valid(s);
  });

  it("keeps the last listener, and moves listening off a deleted one", () => {
    let s = ok(deleteObject(fixtureScene(), "listener1"));
    expect(s.activeListener).toBe("listener2");
    expect(refused(deleteObject(s, "listener2"))).toBe("a scene needs a listener");
    s = ok(deleteObject(s, "obstacle1"));
    expect(findObject(s, "obstacle1")).toBeNull();
    valid(s);
  });

  it("switches the listener that hears the scene", () => {
    const s = ok(setActiveListener(fixtureScene(), "listener2"));
    expect(activeListener(s).name).toBe("Player 2");
    expect(refused(setActiveListener(s, "emitter1"))).toBe("there's no such listener");
  });
});

describe("framing", () => {
  it("frames every place, box and route (2D sounds have none)", () => {
    const pts = framePoints(fixtureScene());
    expect(pts).toContainEqual({ x: 95, y: 0, z: 30 }); // the drone's last waypoint
    expect(pts).toContainEqual({ x: 5, z: 1 }); // the storm front's south-west corner
    expect(Math.min(...pts.map((p) => p.x))).toBe(5);
  });
});

describe("copy, paste, duplicate", () => {
  it("lands 3 m along with a fresh id and a ' copy' name, unlocked", () => {
    const r = ok(duplicateObject(fixtureScene(), "emitter3"));
    const c = findObject(r.scene, r.id)!;
    expect(c.obj).toMatchObject({ name: "Campfire copy", locked: false, position: { x: 33, y: 0.5, z: 25 } });
    expect(r.id).toBe("emitter5");
    const again = ok(pasteObject(r.scene, findObject(fixtureScene(), "emitter3")!));
    expect(findObject(again.scene, again.id)!.obj.name).toBe("Campfire copy 2");
    valid(again.scene);
  });

  it("shifts a moving emitter's whole route, and a copied level default isn't one", () => {
    const r = ok(duplicateObject(fixtureScene(), "emitter4"));
    expect((findObject(r.scene, r.id)!.obj as MovingEmitter).route[0]).toEqual({ x: 13, y: 0, z: 43 });
    const z = ok(patchReverbZone(fixtureScene(), "reverb1", { levelDefault: true }));
    const d = ok(duplicateObject(z, "reverb1"));
    expect(d.scene.reverbZones.map((x) => x.levelDefault)).toEqual([true, false]);
  });
});

describe("fields and routes", () => {
  it("patches an emitter (a static one ignores route fields)", () => {
    const s = ok(patchEmitter(fixtureScene(), "emitter1", { volume: -6, speed: 4 }));
    expect(findObject(s, "emitter1")!.obj).not.toHaveProperty("speed");
    expect(findObject(s, "emitter1")!.obj).toMatchObject({ volume: -6 });
    valid(s);
  });

  it("picks an emitter's output bus, and back to its sound's own", () => {
    const s = ok(patchEmitter(fixtureScene(), "emitter4", { output: "SFX" }));
    expect(findObject(s, "emitter4")!.obj).toMatchObject({ output: "SFX" });
    const back = ok(patchEmitter(s, "emitter4", { output: "" }));
    expect(findObject(back, "emitter4")!.obj).not.toHaveProperty("output");
    valid(back);
  });

  it("one level default at a time", () => {
    let s = ok(newPlace(fixtureScene(), "reverbZone"));
    s = ok(patchReverbZone(s, "reverb1", { levelDefault: true }));
    s = ok(patchReverbZone(s, "reverb2", { levelDefault: true }));
    expect(s.reverbZones.map((z) => z.levelDefault)).toEqual([false, true]);
  });

  it("edits a moving emitter's path: + inserts, removal keeps two", () => {
    let s = ok(insertRoutePoint(fixtureScene(), "emitter4", 0));
    expect((findObject(s, "emitter4")!.obj as MovingEmitter).route).toHaveLength(6);
    for (let i = 0; i < 4; i++) s = ok(removeRoutePoint(s, "emitter4", 0));
    expect(refused(removeRoutePoint(s, "emitter4", 0))).toBe("a route needs at least two waypoints");
    expect(refused(insertRoutePoint(fixtureScene(), "emitter1", 0))).toBe("only a moving emitter has a path");
    valid(s);
  });
});

function newPlace(s: AudioTestScene, tool: Parameters<typeof place>[1]): EditResult<AudioTestScene> {
  const r = place(s, tool, { x: 0, z: 0 }, ctx);
  return "refused" in r ? r : { next: r.next.scene };
}

describe("tools", () => {
  it("places with the prototype's defaults", () => {
    const s = fixtureScene();
    expect(newObject(s, "emitter", { x: 5.2, z: 5.3 }, ctx).obj).toMatchObject({ name: "Emitter 5", kind: "static", position: { x: 5, y: 1.7, z: 5.5 }, volume: 0 });
    const m = newObject(s, "moving", { x: 50, z: 10 }, ctx).obj as MovingEmitter;
    expect(m).toMatchObject({ name: "Moving emitter 2", speed: 8, start: 0.5, height: 5.7 });
    expect(m.route.map((p) => p.x)).toEqual([38, 50, 62]);
    expect(newObject(s, "listener", { x: 0, z: 0 }, ctx).obj.name).toBe("Player 3");
    expect(newObject(s, "obstacle", { x: 0, z: 0 }, { ...ctx, slabLow: 2 }).obj).toMatchObject({ material: "concrete", box: { width: 10, depth: 4, bottom: 2, top: 8 } });
    expect(newObject(s, "reverbZone", { x: 0, z: 0 }, ctx).obj).toMatchObject({ name: "Zone 2", preset: "forest", priority: 2, wet: -16, box: { width: 20, depth: 14, top: 10 } });
    expect(newObject(s, "audioZone", { x: 0, z: 0 }, ctx).obj).toMatchObject({ heard: "edge", feather: 5, box: { width: 20, depth: 8 } });
    expect(newObject(s, "sound2d", { x: 0, z: 0 }, ctx).obj).toMatchObject({ name: "2D sound 2", output: "Master", volume: -6 });
    expect(newObject({ ...s, sounds2d: [] }, "sound2d", { x: 0, z: 0 }, ctx).obj).toMatchObject({ name: "Music", output: "Music" });
    for (const t of ["emitter", "moving", "listener", "obstacle", "reverbZone", "audioZone", "sound2d"] as const) valid(ok(newPlace(s, t)));
    expect(placeLabel("sound2d")).toBe("Add 2D sound");
    expect(placeLabel("reverbZone")).toBe("Add reverb zone");
  });

  it("goes back to Select after placing; a moving emitter opens its path", () => {
    expect(placesByClick("emitter")).toBe(true);
    expect(placesByClick("sound2d")).toBe(false);
    expect(afterPlace("moving", "emitter9")).toEqual({ tool: "select", pathEdit: "emitter9" });
    expect(afterPlace("obstacle", "obstacle4")).toEqual(INITIAL_TOOLS);
    expect(pickTool({ tool: "select", pathEdit: "e" }, "emitter")).toEqual({ tool: "emitter", pathEdit: null });
  });

  it("Esc steps back: path editing, then the tool, then the selection", () => {
    expect(escape({ tool: "select", pathEdit: "e" })).toEqual({ state: INITIAL_TOOLS, deselect: false });
    expect(escape({ tool: "obstacle", pathEdit: null })).toEqual({ state: INITIAL_TOOLS, deselect: false });
    expect(escape(INITIAL_TOOLS)).toEqual({ state: INITIAL_TOOLS, deselect: true });
  });
});

describe("audition", () => {
  it("solo and mute silence objects in the scene the player builds", () => {
    const s = fixtureScene();
    expect(auditionScene(s, NO_AUDITION)).toBe(s);
    const solo = toggleSolo(NO_AUDITION, "emitter1");
    expect(isSilenced(solo, "emitter2")).toBe(true);
    const a = auditionScene(s, solo);
    expect(a.emitters.map((e) => e.sound !== "")).toEqual([true, false, false, false]);
    expect(a.sounds2d[0]!.sound).toBe("");
    expect(toggleSolo(solo, "emitter1").solo).toBeNull();
    const muted = toggleMute(NO_AUDITION, "sound1");
    expect(auditionScene(s, muted).sounds2d[0]!.sound).toBe("");
    expect(toggleMute(muted, "sound1").muted.size).toBe(0);
  });

  it("sends moves as poses and rebuilds for anything else", () => {
    const s = fixtureScene();
    expect(liveUpdate(s, s)).toEqual({ kind: "none" });
    const moved = ok(moveObjectTo(ok(moveObjectTo(s, "listener1", { x: 1, z: 2 })), "obstacle1", { x: 3, z: 4 }));
    const u = liveUpdate(s, moved);
    expect(u.kind).toBe("poses");
    expect(u.kind === "poses" && u.poses.map((p) => [p.id, Object.keys(p.pose)])).toEqual([["listener1", ["position"]], ["obstacle1", ["box"]]]);
    const along = ok(moveObjectTo(s, "emitter4", { x: 10, z: 30 }));
    expect(liveUpdate(s, along)).toEqual({ kind: "poses", poses: [{ id: "emitter4", pose: { at: 0 } }], listener: null });
    expect(liveUpdate(s, ok(setActiveListener(s, "listener2")))).toEqual({ kind: "poses", poses: [], listener: "listener2" });
    expect(liveUpdate(s, ok(renameObject(s, "emitter1", "Falls")))).toEqual({ kind: "none" });
    expect(liveUpdate(s, ok(patchEmitter(s, "emitter1", { volume: -3 })))).toEqual({ kind: "rebuild" });
    expect(liveUpdate(s, ok(deleteObject(s, "emitter1")))).toEqual({ kind: "rebuild" });
  });
});

describe("the base game scene (ADR 0347)", () => {
  it("sets a level of the project as the base, clears it, and refuses a file that isn't a game scene", () => {
    const s = fixtureScene();
    const set = setBaseScene(s, "scenes/level1.scene.json");
    expect("next" in set && set.next.base).toBe("scenes/level1.scene.json");
    const cleared = setBaseScene("next" in set ? set.next : s, null);
    expect("next" in cleared && cleared.next.base).toBeNull();
    expect(setBaseScene(s, "spatial/other.audioscene.json")).toEqual({ refused: "spatial/other.audioscene.json isn't a game scene (a .scene.json file)" });
    expect(isGameScenePath("levels/a.scene.json")).toBe(true);
    expect(isGameScenePath("a.audioscene.json")).toBe(false);
  });
});
