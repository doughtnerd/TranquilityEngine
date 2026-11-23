import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { MovingEmitter, SceneBox } from "../../../engine/audio/spatial/testSceneTypes";
import { emptyMix } from "../mixer/mixerFixture";
import { boxCorners, rotateKnob } from "./geometry";
import { KNOB_PX, beginDrag, dragTo, hitTest, hoverTakesFocus, type HitContext } from "./pointerModel";
import { findObject, positionOf, type EditResult } from "./sceneEdits";
import { addMaterial, dopplerPercent, editMaterial, materialText, removeMaterial, setBedBeyond, setDefaultMaterial, setDopplerPercent, setHrtfVoices } from "./settingsEdits";
import { fixtureScene } from "./spatialFixture";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const ctx = (over: Partial<HitContext> = {}): HitContext => ({ mpp: 0.1, selected: null, pathEdit: null, ...over });

describe("hit testing", () => {
  const scene = fixtureScene();
  const boxOfId = (id: string) => (findObject(scene, id)!.obj as { box: SceneBox }).box;

  it("picks points over boxes, the nearest point, and the smallest box", () => {
    expect(hitTest(scene, { x: 50.3, z: 35.2 }, ctx())).toEqual({ kind: "object", id: "listener1" });
    expect(hitTest(scene, { x: 20, z: 40 }, ctx())).toEqual({ kind: "object", id: "obstacle2" }); // the crates
    expect(hitTest(scene, { x: 75, z: 50 }, ctx())).toEqual({ kind: "object", id: "reverb1" }); // the cave, outside the wall
    expect(hitTest(scene, { x: 67.5, z: 50 }, ctx())).toEqual({ kind: "object", id: "obstacle1" }); // the wall inside the cave
    expect(hitTest(scene, { x: 0, z: 90 }, ctx())).toEqual({ kind: "none" });
  });

  it("leaves out hidden objects", () => {
    expect(hitTest(scene, { x: 42, z: 50 }, ctx())).not.toEqual({ kind: "object", id: "obstacle3" });
  });

  it("grabs the selected box's knob and corners first (not when locked)", () => {
    const b = boxOfId("obstacle2");
    expect(hitTest(scene, rotateKnob(b, KNOB_PX * 0.1), ctx({ selected: "obstacle2" }))).toEqual({ kind: "knob", id: "obstacle2" });
    expect(hitTest(scene, boxCorners(b)[2]!, ctx({ selected: "obstacle2" }))).toEqual({ kind: "corner", id: "obstacle2", index: 2 });
    expect(hitTest(scene, boxCorners(b)[2]!, ctx())).toEqual({ kind: "object", id: "obstacle2" });
  });

  it("grabs waypoints and midpoints of the path being edited", () => {
    expect(hitTest(scene, { x: 35, z: 52 }, ctx({ pathEdit: "emitter4" }))).toEqual({ kind: "waypoint", id: "emitter4", index: 1 });
    expect(hitTest(scene, { x: 22.5, z: 46 }, ctx({ pathEdit: "emitter4" }))).toEqual({ kind: "midpoint", id: "emitter4", index: 0 });
  });
});

describe("dragging", () => {
  const scene = fixtureScene();

  it("keeps the grab offset", () => {
    const drag = beginDrag(scene, { kind: "object", id: "listener1" }, { x: 51, z: 36 })!;
    expect(drag).toEqual({ kind: "move", id: "listener1", offset: { x: -1, z: -1 } });
    const { result, label } = dragTo(scene, drag, { x: 61, z: 46 });
    expect(label).toBe("Move listener");
    expect(positionOf(findObject(ok(result), "listener1")!)).toEqual({ x: 60, y: 1.7, z: 45 });
  });

  it("doesn't move locked objects, 2D sounds or '+' presses", () => {
    expect(beginDrag(scene, { kind: "object", id: "emitter3" }, { x: 30, z: 22 })).toBeNull();
    expect(beginDrag(scene, { kind: "object", id: "sound1" }, { x: 0, z: 0 })).toBeNull();
    expect(beginDrag(scene, { kind: "midpoint", id: "emitter4", index: 0 }, { x: 0, z: 0 })).toBeNull();
  });

  it("slides a moving emitter along its path", () => {
    const drag = beginDrag(scene, { kind: "object", id: "emitter4" }, { x: 1, z: 1 })!;
    const next = ok(dragTo(scene, drag, { x: 95, z: 25 }).result);
    expect((findObject(next, "emitter4")!.obj as MovingEmitter).start).toBe(1);
  });

  it("resizes from a corner and turns from the knob, with each kind's label", () => {
    const r = dragTo(scene, { kind: "corner", id: "reverb1" }, { x: 105, z: 75 });
    expect(r.label).toBe("Edit reverb zone");
    expect((findObject(ok(r.result), "reverb1")!.obj as { box: SceneBox }).box).toMatchObject({ width: 50, depth: 55 });
    const k = dragTo(scene, { kind: "knob", id: "zone1" }, { x: 40, z: 12 });
    expect(k.label).toBe("Edit audio zone");
    expect((findObject(ok(k.result), "zone1")!.obj as { box: SceneBox }).box.yaw).toBe(90);
    const w = dragTo(scene, { kind: "waypoint", id: "emitter4", index: 0 }, { x: 0.2, z: 0.2 });
    expect(w.label).toBe("Edit path");
    expect((findObject(ok(w.result), "emitter4")!.obj as MovingEmitter).route[0]).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("scene settings on audio.json", () => {
  const valid = (p: AudioProject) => {
    const back = parseAudioProject(audioProjectToJson(p));
    expect(back.problems).toEqual([]);
    expect(back.project.settings).toEqual(p.settings);
  };

  it("sets HRTF voices, bed distance and Doppler amount within their ranges", () => {
    let p = ok(setHrtfVoices(emptyMix(), 4.4));
    expect(p.settings.voices.hrtf).toBe(4);
    expect(ok(setHrtfVoices(p, 99)).settings.voices.hrtf).toBe(32);
    p = ok(setBedBeyond(p, 45));
    expect(p.settings.bedBeyond).toBe(45);
    expect(setBedBeyond(p, 0)).toEqual({ refused: "the bed distance is a number of metres above 0" });
    p = ok(setDopplerPercent(p, 50));
    expect(p.settings.dopplerAmount).toBe(0.5);
    expect(dopplerPercent(ok(setDopplerPercent(p, 500)))).toBe(200);
    valid(p);
    valid(ok(setBedBeyond(p, null)));
  });

  it("edits the material table: add, change, rename, remove, default", () => {
    const added = ok(addMaterial(emptyMix()));
    expect(added.name).toBe("Material");
    let p = ok(editMaterial(added.project, "Material", { name: "Rock", transmissionDb: -9, cutoffHz: 1200 }));
    expect(p.settings.occlusion.materials.find((m) => m.name === "Rock")).toMatchObject({ transmissionDb: -9, cutoffHz: 1200 });
    expect(editMaterial(p, "wood", { name: "Oak" })).toEqual({ refused: "wood is a built-in material: it can be changed but not renamed" });
    expect(editMaterial(p, "Rock", { name: "wood" })).toEqual({ refused: 'another material is named "wood"' });
    p = ok(editMaterial(p, "wood", { transmissionDb: -200 }));
    expect(p.settings.occlusion.materials.find((m) => m.name === "wood")!.transmissionDb).toBe(-80);
    p = ok(setDefaultMaterial(p, "Rock"));
    expect(removeMaterial(p, "Rock")).toEqual({ refused: "Rock is the default material" });
    expect(removeMaterial(p, "metal")).toEqual({ refused: "metal is a built-in material: it can be changed but not removed" });
    valid(p);
    p = ok(setDefaultMaterial(p, "concrete"));
    p = ok(removeMaterial(p, "Rock"));
    expect(p.settings.occlusion.materials.some((m) => m.name === "Rock")).toBe(false);
    valid(p);
    expect(materialText({ name: "x", transmissionDb: -30, cutoffHz: 800, wetOcclusion: 0.5 })).toBe("−30 dB · low-pass 800 Hz");
  });
});

describe("the pointer over the plan takes the keyboard (UI pass SV13, D27)", () => {
  const el = (tagName: string, more: { type?: string; isContentEditable?: boolean; inside?: string } = {}) => ({
    tagName,
    type: more.type,
    isContentEditable: more.isContentEditable ?? false,
    closest: (sel: string) => (more.inside && sel.includes(more.inside) ? {} : null),
  });

  it("from the page, a button or another panel, so Space pans and +/−/arrows work there rather than Space playing", () => {
    expect(hoverTakesFocus(null)).toBe(true);
    expect(hoverTakesFocus(el("BODY"))).toBe(true);
    expect(hoverTakesFocus(el("BUTTON"))).toBe(true);
    expect(hoverTakesFocus(el("DIV"))).toBe(true); // the Scenes tree, the Outline
    expect(hoverTakesFocus(el("INPUT", { type: "checkbox" }))).toBe(true);
    expect(hoverTakesFocus(el("INPUT", { type: "range" }))).toBe(true);
  });

  it("but not from a field being typed in, an open menu or a dialog", () => {
    expect(hoverTakesFocus(el("INPUT", { type: "text" }))).toBe(false);
    expect(hoverTakesFocus(el("INPUT", { type: "search" }))).toBe(false);
    expect(hoverTakesFocus(el("INPUT", { type: "" }))).toBe(false);
    expect(hoverTakesFocus(el("TEXTAREA"))).toBe(false);
    expect(hoverTakesFocus(el("SELECT"))).toBe(false);
    expect(hoverTakesFocus(el("DIV", { isContentEditable: true }))).toBe(false);
    expect(hoverTakesFocus(el("BUTTON", { inside: '[role="menu"]' }))).toBe(false);
    expect(hoverTakesFocus(el("BUTTON", { inside: '[role="dialog"]' }))).toBe(false);
  });
});
