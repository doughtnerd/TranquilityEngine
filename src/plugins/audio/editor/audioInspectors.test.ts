// The audio Inspector sections and the occluder gizmo (ADR 0162 E2): the three occluder warnings (no collider, no 3D
// physics service, another occluder overriding), the zone's cost line and Babylon warning, the `output` bus choices,
// the ambisonic greying list, the occluder overlay, and the sections' writes through the editor's undo stack.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioOccluder, AudioReverbZone, AudioSource, Engine } from "../../../myco";
import { AddComponent, RenameNode, SetField } from "../../../editor/document";
import { createNode } from "../../../editor/nodeCreate";
import { openSceneFile } from "../../../editor/project";
import { componentNotes } from "../../../editor/sdk";
import { choicesFor } from "../../../editor/fieldValues";
import { getFields } from "../../../engine/core/registry";
import { openScene, playState, selection } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { occluderOverlay } from "./AudioOccluderGizmo";
import {
  AMBISONIC_IGNORED_FIELDS,
  analyzeOccluder,
  audioOfProject,
  blendColor,
  coveredColliders,
  describeCost,
  materialTint,
  occluderCost,
  physics3dAvailable,
  sendCurveOf,
  zoneCostLine,
  zoneNotices,
  zoneReverbLine,
} from "./audioInspectorModel";
import { dragGroup, writeField } from "./inspectorWrite";

const OCC = "engine.AudioOccluder";
const BOX = "engine.BoxCollider";
const defaults = audioOfProject(undefined);
const codes = (o: AudioOccluder, physics3d = true, audio = defaults) => analyzeOccluder(o, { physics3d, audio }).warnings.map((w) => w.code);

describe("audio inspector sections", () => {
  let engine: Engine;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    playState.value = "edit";
  });
  afterEach(() => {
    selection.value = null;
    engine.dispose();
  });

  /** A node with the given components (type, data); returns the live node. */
  function node(components: [string, Record<string, unknown>?][], parent?: string) {
    const scene = openScene.value!;
    const id = createNode(scene, "empty", { position: [0, 0, 0], ...(parent ? { parent } : {}) } as never);
    for (const [type, data] of components) scene.stack.execute(new AddComponent(id, { type, data: data ?? {} }));
    return { scene, id, node: scene.sync.nodeFor(id)! };
  }
  const occluderOf = (n: { node: { getBehavior: (t: typeof AudioOccluder) => AudioOccluder | null } }) => n.node.getBehavior(AudioOccluder)!;

  describe("occluder warnings", () => {
    it("warns when there is no collider on the node or below it", () => {
      const wall = node([[OCC]]);
      expect(codes(occluderOf(wall))).toEqual(["noCollider"]);
      const withCollider = node([[OCC], [BOX]]);
      expect(codes(occluderOf(withCollider))).toEqual([]);
    });

    it("counts a collider on a child, and says nothing about one outside the subtree", () => {
      const wall = node([[OCC]]);
      expect(codes(occluderOf(wall))).toEqual(["noCollider"]);
      node([[BOX]]); // a sibling elsewhere: not below the wall
      expect(codes(occluderOf(wall))).toEqual(["noCollider"]);
      const scene = wall.scene;
      const child = createNode(scene, "empty", { position: [0, 0, 0], parent: wall.id } as never);
      scene.stack.execute(new AddComponent(child, { type: BOX, data: {} }));
      expect(codes(occluderOf({ node: scene.sync.nodeFor(wall.id)! } as never))).toEqual([]);
    });

    it("warns when the project has no 3D physics service: occlusion is inert", () => {
      const wall = node([[OCC], [BOX]]);
      expect(codes(occluderOf(wall), false)).toEqual(["noService"]);
      expect(analyzeOccluder(occluderOf(wall), { physics3d: false, audio: defaults }).warnings[0]!.text).toMatch(/no 3D physics service/);
    });

    it("finds the 3D physics service through the Physics plugin's 'no physics backend' note", () => {
      expect(physics3dAvailable()).toBe(true);
      const undo = componentNotes.register({ id: "test.no-backend", note: (type) => (type === "engine.BoxCollider" ? "(no physics backend)" : null) });
      expect(physics3dAvailable()).toBe(false);
      undo();
      expect(physics3dAvailable()).toBe(true);
    });

    it("warns about an overriding occluder below, naming it and its material", () => {
      const room = node([[OCC, { material: "wood" }]]);
      const scene = room.scene;
      const door = createNode(scene, "empty", { position: [0, 0, 0], parent: room.id } as never);
      scene.stack.execute(new RenameNode(door, "Door"));
      scene.stack.execute(new AddComponent(door, { type: BOX, data: {} }));
      scene.stack.execute(new AddComponent(door, { type: OCC, data: { material: "glass" } }));
      const wallCollider = createNode(scene, "empty", { position: [0, 0, 0], parent: room.id } as never);
      scene.stack.execute(new AddComponent(wallCollider, { type: BOX, data: {} }));
      const roomNode = scene.sync.nodeFor(room.id)!;
      const report = analyzeOccluder(roomNode.getBehavior(AudioOccluder)!, { physics3d: true, audio: defaults });
      expect(report.warnings.map((w) => w.code)).toEqual(["overlap"]);
      expect(report.warnings[0]!.text).toContain('"Door"');
      expect(report.warnings[0]!.text).toContain("glass");
      expect(report.overrides).toEqual([{ node: "Door", material: "glass", colliders: 1 }]);
      expect(report.covered).toHaveLength(1); // the other child's collider
    });

    it("an occluder whose every collider is overridden is not 'no collider': it says who overrides", () => {
      const room = node([[OCC]]);
      const scene = room.scene;
      const door = createNode(scene, "empty", { position: [0, 0, 0], parent: room.id } as never);
      scene.stack.execute(new AddComponent(door, { type: BOX, data: {} }));
      scene.stack.execute(new AddComponent(door, { type: OCC, data: {} }));
      expect(codes(scene.sync.nodeFor(room.id)!.getBehavior(AudioOccluder)!)).toEqual(["overlap"]);
    });

    it("warns about an unknown material, a second occluder on the node, triggers only and a disabled occluder", () => {
      const unknown = node([[OCC, { material: "marble" }], [BOX]]);
      expect(codes(occluderOf(unknown))).toEqual(["unknownMaterial"]);
      const twice = node([[OCC], [OCC], [BOX]]);
      expect(codes(occluderOf(twice))).toEqual(["twoOnNode"]);
      const trigger = node([[OCC], [BOX, { isTrigger: true }]]);
      expect(codes(occluderOf(trigger))).toEqual(["inert"]);
      const off = node([[OCC], [BOX]]);
      const live = off.scene.sync.nodeFor(off.id)!.getBehavior(AudioOccluder)!;
      live.enabled = false;
      expect(codes(live)).toContain("disabled");
    });

    it("treats a layer outside audio.occlusion.layers as inert", () => {
      const audio = parseAudioSettings({ occlusion: { layers: ["Water"] } }).settings;
      const wall = node([[OCC], [BOX]]); // layer "Default"
      expect(codes(occluderOf(wall), true, audio)).toEqual(["inert"]);
    });

    it("lists the colliders it covers: its node's and those of descendants without an occluder", () => {
      const wall = node([[OCC], [BOX]]);
      expect(coveredColliders(occluderOf(wall))).toHaveLength(1);
    });
  });

  describe("material read-out", () => {
    it("applies the trims and openness to the material's row, and names the default material for an empty choice", () => {
      const wall = node([[OCC, { material: "wood", transmissionTrimDb: -5, cutoffScale: 0.5, openness: 0 }]]);
      const o = occluderOf(wall);
      const closed = occluderCost(o, defaults);
      const wood = defaults.occlusion.materials.find((m) => m.name === "wood")!;
      expect(closed.transmissionDb).toBeCloseTo(wood.transmissionDb - 5, 6);
      expect(closed.cutoffHz).toBeCloseTo(wood.cutoffHz * 0.5, 6);
      expect(occluderCost(o, defaults, 1).transmissionDb).toBeCloseTo(0, 9); // fully open: transparent
      expect(occluderCost({ ...o, material: "" } as AudioOccluder, defaults).material).toBe(defaults.occlusion.defaultMaterial);
      expect(describeCost(closed)).toMatch(/dB, .* Hz low-pass/);
    });
  });

  describe("occluder gizmo", () => {
    it("outlines the colliders an occluder applies to, tinted by material, dimmer unselected and as it opens", () => {
      const wall = node([[OCC, { material: "glass" }], [BOX]]);
      node([[BOX]]); // no occluder: not drawn here
      const dim = occluderOverlay(engine);
      expect(dim.lines).toHaveLength(12); // one box
      selection.value = wall.id;
      const bright = occluderOverlay(engine);
      expect(bright.lines).toHaveLength(12);
      expect(bright.lines[0]!.color).toBe(materialTint(defaults, "glass"));
      expect(dim.lines[0]!.color).not.toBe(bright.lines[0]!.color);
      wall.scene.stack.execute(new SetField(wall.id, OCC, "openness", 1));
      expect(occluderOverlay(engine).lines[0]!.color).not.toBe(bright.lines[0]!.color);
    });

    it("draws a sphere collider as three circles and gives each material its own tint", () => {
      node([[OCC], ["engine.SphereCollider"]]);
      expect(occluderOverlay(engine).lines).toHaveLength(3);
      const tints = new Set(["concrete", "cloth", "wood", "glass", "metal", "none", "custom"].map((m) => materialTint(defaults, m)));
      expect(tints.size).toBe(7);
      expect(materialTint(defaults, "")).toBe(materialTint(defaults, defaults.occlusion.defaultMaterial));
      expect(blendColor(0xffffff, 0x000000, 0.5)).toBe(0x808080);
    });

    it("follows a descendant's own occluder: the child is outlined in its own material", () => {
      const room = node([[OCC, { material: "wood" }]]);
      const scene = room.scene;
      const door = createNode(scene, "empty", { position: [0, 0, 0], parent: room.id } as never);
      scene.stack.execute(new AddComponent(door, { type: BOX, data: {} }));
      selection.value = room.id;
      expect(occluderOverlay(engine).lines[0]!.color).toBe(materialTint(defaults, "wood"));
      scene.stack.execute(new AddComponent(door, { type: OCC, data: { material: "glass" } }));
      selection.value = door;
      expect(occluderOverlay(engine).lines[0]!.color).toBe(materialTint(defaults, "glass"));
    });
  });

  describe("zone section", () => {
    it("says what the zone costs from the project's zone slots, and nothing while zones are off", () => {
      const line = zoneCostLine(defaults)!;
      expect(line).toMatch(/one reverb slot, about \d/);
      expect(line).toMatch(/\d+ slots \(2 active, 1 standby\)/);
      const off = parseAudioSettings({ zones: { maxActive: 0 } }).settings;
      expect(zoneCostLine(off)).toBeNull();
    });

    it("warns when the backend is Babylon, when zones are off, and about an unknown output bus or impulse response", () => {
      const zone = { output: "", ir: "", preset: "hall" };
      expect(zoneNotices(zone, defaults, [])).toEqual([]);
      const babylon = parseAudioSettings({ backend: "babylon" }).settings;
      expect(zoneNotices(zone, babylon, []).map((n) => n.text).join(" ")).toMatch(/Babylon.*inert/);
      const off = parseAudioSettings({ zones: { maxActive: 0 } }).settings;
      expect(zoneNotices(zone, off, [])[0]!.text).toMatch(/off in this project/);
      expect(zoneNotices({ ...zone, output: "Nope" }, defaults, [])[0]!.text).toMatch(/no bus named "Nope".*Master/);
      expect(zoneNotices({ ...zone, output: "Music" }, defaults, [])).toEqual([]);
      expect(zoneNotices({ ...zone, ir: "asset:audio/cave.wav" }, defaults, ["audio/other.wav"])[0]!.text).toMatch(/audio\/cave\.wav.*not in the project.*hall/);
      expect(zoneNotices({ ...zone, ir: "asset:audio/cave.wav" }, defaults, ["audio/cave.wav"])).toEqual([]);
    });

    it("says which reverb plays: the preset, or the impulse response that overrides it", () => {
      expect(zoneReverbLine({ ir: "", preset: "cave" })).toBe("Reverb: the cave preset.");
      expect(zoneReverbLine({ ir: "asset:a.wav", preset: "cave" })).toMatch(/impulse response a\.wav.*overrides the cave preset/);
    });

    it("offers the project's buses for `output`, with Master (empty) first", () => {
      const field = getFields(AudioReverbZone).find((f) => f.name === "output")!;
      const choices = choicesFor({ name: "output", type: field.type, value: "", options: field.options } as never, { audio: { buses: [{ name: "Master" }, { name: "Music" }, { name: "Reverbs" }] } } as never) ?? [];
      const values = choices.map((c) => c.value);
      expect(values[0]).toBe("");
      expect(values).toContain("Reverbs");
    });
  });

  describe("audio source section", () => {
    it("lists the fields an ambisonic clip ignores: spatial, the distance fields, rolloff, occlusion and Doppler", () => {
      const names = getFields(AudioSource).map((f) => f.name);
      for (const f of AMBISONIC_IGNORED_FIELDS) expect(names).toContain(f);
      expect(AMBISONIC_IGNORED_FIELDS).not.toContain("reverbSend");
      expect(AMBISONIC_IGNORED_FIELDS).not.toContain("ambisonicYaw");
    });

    it("reads the send curve as sorted [x, y] keys, the default when it isn't a curve", () => {
      expect(sendCurveOf(undefined)).toEqual([[0, 1], [1, 0.5]]);
      expect(sendCurveOf([])).toEqual([[0, 1], [1, 0.5]]);
      expect(sendCurveOf([[1, 0], [0, 2, "smooth"], ["x", 1]])).toEqual([[0, 2], [1, 0]]);
    });
  });

  describe("writing fields with undo", () => {
    it("writes the send curve and openness as undo steps; a drag group is one step", () => {
      const src = node([["engine.AudioSource"]]);
      const target = { scene: src.scene, path: [src.id], type: "engine.AudioSource", index: 0 };
      const live = () => src.scene.sync.nodeFor(src.id)!.getBehavior(AudioSource)!;
      writeField(target, "reverbSendCurve", [[0, 1], [1, 0.25]]);
      expect(live().reverbSendCurve).toEqual([[0, 1], [1, 0.25]]);
      src.scene.stack.undo();
      expect(live().reverbSendCurve).toEqual([[0, 1], [1, 0.5]]);
      src.scene.stack.redo();
      expect(live().reverbSendCurve).toEqual([[0, 1], [1, 0.25]]);

      const wall = node([[OCC]]);
      const t = { scene: wall.scene, path: [wall.id], type: OCC, index: 0 };
      const openness = () => wall.scene.sync.nodeFor(wall.id)!.getBehavior(AudioOccluder)!.openness;
      const group = dragGroup(wall.scene, "Drag openness");
      group.onPointerDownCapture();
      group.onPointerDownCapture(); // a second press while open changes nothing
      for (const v of [0.2, 0.5, 0.9]) writeField(t, "openness", v);
      group.onPointerUp();
      group.onPointerUp(); // closing twice is harmless
      expect(openness()).toBe(0.9);
      expect(wall.scene.stack.undoLabel).toBe("Drag openness");
      wall.scene.stack.undo();
      expect(openness()).toBe(0);
      wall.scene.stack.redo();
      expect(openness()).toBe(0.9);
    });
  });
});
