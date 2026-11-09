import { describe, expect, it } from "vitest";
import { CORE_SETTINGS_KEYS, readDraft, type SettingsDraft } from "../../../editor/projectSettingsModel";
import { raw } from "../../../editor/testing";
import { addLayer, collides, physicsSettingsProblems, removeLayer, renameLayer, setCollides, setGravity } from "./physicsSettingsModel";

// The Physics settings section's model (ADR 0038, 0151): project.json's `physics` key, which the section owns.

const FLAPPY = raw["../../samples/flappy/project.json"];
const flappy = () => readDraft(JSON.parse(FLAPPY), [...CORE_SETTINGS_KEYS, "physics"]);
const messages = (d: SettingsDraft) => physicsSettingsProblems(d).map((p) => p.message);

describe("the Physics section's settings", () => {
  it("finds nothing wrong with the sample's physics", () => {
    expect(physicsSettingsProblems(flappy())).toEqual([]);
  });

  it("reports duplicate layer names, too many layers and unknown layers in the matrix, by field", () => {
    expect(messages(renameLayer(flappy(), 2, "Player"))).toContain('Physics layers: "Player" is listed twice.');
    expect(physicsSettingsProblems(renameLayer(flappy(), 2, "")).map((p) => p.field)).toContain("physics.layers.2");
    let d = flappy();
    for (let i = 0; i < 11; i++) d = addLayer(d);
    expect(messages(d)).toContain("There can be at most 16 physics layers.");
    expect(messages({ physics: { layers: ["Default"], collisionMatrix: { Default: ["Ghost"] } } })).toEqual([expect.stringContaining('"Ghost"')]);
    expect(physicsSettingsProblems({ physics: { gravity: [0] as never } }).map((p) => p.field)).toEqual(["physics.gravity"]);
  });

  it("edits the collision matrix as symmetric pairs, written under the earlier layer", () => {
    let d = flappy();
    expect(collides(d, "Player", "Ground")).toBe(true);
    expect(collides(d, "Ground", "Player")).toBe(true);
    expect(collides(d, "Player", "Player")).toBe(false);
    expect(collides(d, "Default", "Default")).toBe(false);
    d = setCollides(d, "Ground", "Player", false);
    d = setCollides(d, "Obstacle", "Obstacle", true);
    expect(d.physics!.collisionMatrix).toEqual({ Player: ["Obstacle", "Score", "Bounds"], Obstacle: ["Obstacle"] });
  });

  it("with no matrix every layer collides; unchecking one pair writes the rest out, checking it back removes the matrix", () => {
    let d: SettingsDraft = { physics: { layers: ["Default", "A"] } };
    expect(collides(d, "A", "Default")).toBe(true);
    d = setCollides(d, "A", "A", false);
    expect(d.physics!.collisionMatrix).toEqual({ Default: ["Default", "A"] });
    d = setCollides(d, "A", "A", true);
    expect(d.physics).toEqual({ layers: ["Default", "A"] });
  });

  it("keeps the matrix in step when layers are added, renamed and removed", () => {
    let d = flappy();
    d = addLayer(d);
    expect(d.physics!.layers!.at(-1)).toBe("Layer");
    expect(collides(d, "Layer", "Player")).toBe(false); // with a matrix, a new layer collides with nothing
    d = renameLayer(d, 1, "Hero");
    expect(d.physics!.collisionMatrix).toEqual({ Hero: ["Obstacle", "Score", "Ground", "Bounds"] });
    d = removeLayer(d, 4); // Ground
    expect(d.physics!.collisionMatrix).toEqual({ Hero: ["Obstacle", "Score", "Bounds"] });
    expect(removeLayer({ physics: { layers: ["Default"] } }, 0)).toEqual({ physics: { layers: ["Default"] } });
    const open = addLayer({});
    expect(open.physics).toEqual({ layers: ["Default", "Layer"] }); // no matrix: the new layer collides with everything
  });

  it("edits gravity, keeping z only while it isn't 0", () => {
    expect(setGravity({}, 1, -20).physics!.gravity).toEqual([0, -20]);
    expect(setGravity({}, 2, 3).physics!.gravity).toEqual([0, -9.81, 3]);
  });
});
