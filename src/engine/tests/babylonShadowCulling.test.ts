// ADR 0075: per-cascade shadow caster culling. Babylon's cascaded shadow maps drew every caster into
// every cascade; each cascade now gets the casters inside its sides and nearer the light than its far
// side, keeping those between the light and the box (depth clamping still draws them).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cascadeCasterList } from "../render/babylon/shadowCulling";

describe("Babylon cascade caster culling", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => engine.dispose());

  /** A light above the origin looking straight down; its cascade box 20 m wide, 10 to 50 m below it. */
  function cascade(): Matrix {
    const view = Matrix.LookAtLH(new Vector3(0, 60, 0), Vector3.Zero(), new Vector3(0, 0, 1));
    const projection = Matrix.OrthoOffCenterLH(-10, 10, -10, 10, 10, 50);
    return view.multiply(projection);
  }

  function box(name: string, x: number, y: number, z: number) {
    const m = CreateBox(name, { size: 1 }, scene);
    m.position.set(x, y, z);
    m.computeWorldMatrix(true);
    return m;
  }

  it("keeps the casters inside a cascade's sides and drops those outside", () => {
    const inside = box("inside", 3, 20, -4);
    const outside = box("outside", 30, 20, 0);
    const edge = box("edge", 10.3, 20, 0); // overlaps the side by 0.2 m
    const list = cascadeCasterList(() => cascade());
    const meshes = [inside, outside, edge];
    expect(list(0, meshes, meshes.length)?.map((m) => m.name)).toEqual(["inside", "edge"]);
  });

  it("keeps casters between the light and the box, drops those past its far side", () => {
    const aboveNear = box("aboveNear", 0, 55, 0); // 5 m below the light: in front of the near plane
    const pastFar = box("pastFar", 0, 2, 0); // 58 m below the light: past the far plane at 50
    const list = cascadeCasterList(() => cascade());
    expect(list(0, [aboveNear, pastFar], 2)?.map((m) => m.name)).toEqual(["aboveNear"]);
  });

  it("lists each cascade separately, and the whole list without a matrix", () => {
    const a = box("a", 0, 20, 0);
    const far = box("far", 40, 20, 0);
    const wide = Matrix.LookAtLH(new Vector3(0, 60, 0), Vector3.Zero(), new Vector3(0, 0, 1)).multiply(Matrix.OrthoOffCenterLH(-50, 50, -50, 50, 10, 50));
    const list = cascadeCasterList((layer) => (layer === 0 ? cascade() : layer === 1 ? wide : null));
    const meshes = [a, far];
    const first = list(0, meshes, 2)!.map((m) => m.name);
    const second = list(1, meshes, 2)!.map((m) => m.name);
    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "far"]);
    expect(list(2, meshes, 2)).toBeNull();
  });

  it("only looks at the first `length` entries", () => {
    const a = box("a", 0, 20, 0);
    const b = box("b", 1, 20, 0);
    expect(cascadeCasterList(() => cascade())(0, [a, b], 1)?.map((m) => m.name)).toEqual(["a"]);
  });
});
