// ADR 0446 §3: each view's object list is the scene's meshes no per-view feature owns, plus what each chose for the
// view; probe lists can leave meshes out (the editor's); cascade expanders combine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ViewDrawing } from "./feature";
import { aabbInPlanes, type CascadeExpander } from "./shadowCulling";
import { ViewObjectLists, cascadesOf } from "./viewObjects";

describe("per-view object lists (ADR 0446 §3)", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => engine.dispose());

  const drawing = (owned: AbstractMesh[], perView: AbstractMesh[][], cascades: CascadeExpander | null = null): ViewDrawing => ({
    owns: (m) => owned.includes(m),
    meshes: (i, out) => out.push(...(perView[i] ?? [])),
    cascades,
  });

  it("lists the scene's other meshes in every view, and each drawing's choice per view", () => {
    const sprite = new Mesh("sprite", scene), water = new Mesh("water", scene);
    const lod0 = new Mesh("lod0", scene), lod1 = new Mesh("lod1", scene), pooled = new Mesh("pooled", scene);
    const lists = new ViewObjectLists().build(scene.meshes, [drawing([lod0, lod1, pooled], [[lod1], [lod0], []])], 3);
    const names = lists.map((l) => l.map((m) => m.name));
    expect(names).toEqual([
      ["sprite", "water", "lod1"],
      ["sprite", "water", "lod0"],
      ["sprite", "water"],
    ]);
    expect(sprite && water).toBeTruthy();
  });

  it("leaves out what a view's exclusion rejects from the scene's meshes, not from a drawing's choice", () => {
    const grid = new Mesh("grid", scene);
    new Mesh("rock", scene);
    const chosen = new Mesh("chosen", scene);
    const lists = new ViewObjectLists().build(scene.meshes, [drawing([chosen], [[chosen], [chosen]])], 2, (i) => (i === 1 ? (m) => m === grid || m === chosen : null));
    expect(lists.map((l) => l.map((m) => m.name))).toEqual([
      ["grid", "rock", "chosen"],
      ["rock", "chosen"],
    ]);
  });

  it("combines cascade expanders: the first that claims a caster expands it", () => {
    const a = new Mesh("a", scene), b = new Mesh("b", scene), out = new Mesh("out", scene);
    const claim = (mine: AbstractMesh): CascadeExpander => ({ expand: (m, _l, _layer, _p, o) => (m === mine ? (o.push(out), true) : false) });
    expect(cascadesOf([drawing([], [])])).toBeNull();
    const one = claim(a);
    expect(cascadesOf([drawing([], [], one)])).toBe(one);
    const both = cascadesOf([drawing([], [], claim(a)), drawing([], [], claim(b))])!;
    const got: AbstractMesh[] = [];
    expect(both.expand(b, 1, 0, [], got)).toBe(true);
    expect(both.expand(out, 1, 0, [], got)).toBe(false);
    expect(got).toEqual([out]);
  });

  it("tests a world AABB against planes by its corner furthest along each normal", () => {
    const planes = [new Plane(1, 0, 0, 0), new Plane(0, 1, 0, -2)]; // x ≥ 0, y ≥ 2
    expect(aabbInPlanes([-1, 1, 0, 0.5, 3, 1], planes)).toBe(true); // reaches x 0.5, y 3
    expect(aabbInPlanes([-1, 1, 0, -0.1, 3, 1], planes)).toBe(false);
    expect(aabbInPlanes([0, 0, 0, 1, 1.9, 1], planes)).toBe(false);
    expect(aabbInPlanes([9, 9, 9, 0, 0, 0, 1, 2, 0, 2, 3, 1], planes, 6)).toBe(true);
  });
});
