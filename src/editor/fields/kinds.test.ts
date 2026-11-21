// Field kinds (ADR 0273): every kind's scene-file form, sameness, blank value, unset rule and axis edits, through
// `fieldKind(field)` and the table, as the Inspector's callers use them.
import { describe, expect, it } from "vitest";
import { AssetRef, Color, GameObject, PlainObject, Quaternion, Vector2, Vector3 } from "../../engine";
import type { FieldValue } from "../../engine/editor";
import { FIELD_KINDS, fieldKind, noNodeRefs, type FieldKindName, type NodeIds } from "./kinds";
import { rotationCodec } from "./rotationCodec";

const field = (type: unknown, value: unknown = null, options?: FieldValue["options"]): FieldValue => ({ name: "f", type: type as never, value, options });
const kindOf = (type: unknown, value: unknown = null, options?: FieldValue["options"]) => fieldKind(field(type, value, options));
const b = { name: "B" } as GameObject;
const c = { name: "C" } as GameObject;
const ids: NodeIds = (n) => (n === b ? "b" : n === c ? "c" : null);

describe("picking a field's kind", () => {
  it("from the declared type, a data component's scalar type, choices, or the live value's shape", () => {
    const names: [unknown, FieldKindName][] = [
      [Number, "number"],
      [Boolean, "boolean"],
      [String, "string"],
      [AssetRef, "asset"],
      [Color, "color"],
      [Vector2, "vector2"],
      [Vector3, "vector3"],
      [Quaternion, "quaternion"],
      [GameObject, "node"],
      [PlainObject, "object"],
      [{ kind: "f32" }, "number"],
      [{ kind: "u8" }, "integer"],
      [Symbol, "unknown"],
    ];
    for (const [type, name] of names) expect(kindOf(type).name, String(name)).toBe(name);
    expect(kindOf(String, "", { choices: ["a", "b"] }).name).toBe("choice");
    expect(kindOf(undefined, 2).name).toBe("number");
    expect(kindOf(undefined, true).name).toBe("boolean");
    expect(kindOf(undefined, "x").name).toBe("string");
    expect(kindOf(undefined, {}).name).toBe("unknown");
  });

  it("a list's kind carries its item kind, choices included", () => {
    expect(kindOf([Vector2]).item).toBe(FIELD_KINDS.vector2);
    expect(kindOf([GameObject]).item).toBe(FIELD_KINDS.node);
    expect(kindOf([String], [], { choices: ["slow", "fast"] }).item).toBe(FIELD_KINDS.choice);
    expect(kindOf([Symbol]).savable).toBe(false);
  });
});

describe("scene-file forms", () => {
  it("scalars, assets and colors", () => {
    expect(FIELD_KINDS.number.toJSON("2.5", noNodeRefs)).toBe(2.5);
    expect(FIELD_KINDS.integer.toJSON(2.6, noNodeRefs)).toBe(3);
    expect(FIELD_KINDS.boolean.toJSON(1, noNodeRefs)).toBe(true);
    expect(FIELD_KINDS.string.toJSON("hi", noNodeRefs)).toBe("hi");
    expect(FIELD_KINDS.choice.toJSON("fast", noNodeRefs)).toBe("fast");
    expect(FIELD_KINDS.asset.toJSON("images/bird.png", noNodeRefs)).toBe("asset:images/bird.png");
    expect(FIELD_KINDS.asset.toJSON("asset:images/bird.png", noNodeRefs)).toBe("asset:images/bird.png");
    expect(FIELD_KINDS.asset.toJSON(null, noNodeRefs)).toBe("");
    expect(FIELD_KINDS.color.toJSON(new Color(1, 0, 0, 1), noNodeRefs)).toBe("#ff0000");
    expect(FIELD_KINDS.color.toJSON(new Color(0, 1, 0, 0.5), noNodeRefs)).toBe("#00ff0080");
    expect(FIELD_KINDS.color.toJSON(null, noNodeRefs)).toBeNull();
    const settings = { a: { b: 1 } };
    const json = FIELD_KINDS.object.toJSON(settings, noNodeRefs);
    expect(json).toEqual(settings);
    expect(json).not.toBe(settings);
  });

  it("vectors and rotations", () => {
    expect(FIELD_KINDS.vector3.toJSON(new Vector3(1, 2, 3), noNodeRefs)).toEqual([1, 2, 3]);
    expect(FIELD_KINDS.vector2.toJSON([1, 2], noNodeRefs)).toEqual([1, 2]);
    expect(FIELD_KINDS.vector2.toJSON(null, noNodeRefs)).toBeNull();
    // Rotations are quaternions (ADR 0163) in the rotation codec's form, from a Quaternion or Euler radians (ZXY).
    const rotation = FIELD_KINDS.quaternion;
    expect(rotation.toJSON([0, 0, Math.PI / 2], noNodeRefs)).toEqual([0, 0, 0.7071068, 0.7071068]);
    expect(rotation.toJSON(new Quaternion(0, -0.7071068, 0, -0.7071068), noNodeRefs)).toEqual([0, 0.7071068, 0, 0.7071068]);
    expect(rotation.toJSON(Quaternion.fromEuler(0, 0, Math.PI / 6), noNodeRefs)).toEqual(rotationCodec("degrees").toJSON(Quaternion.fromEuler(0, 0, Math.PI / 6)));
    expect(rotation.toJSON(null, noNodeRefs)).toBeNull();
  });

  it("node references by the id the caller's resolution gives, null where it has none", () => {
    expect(FIELD_KINDS.node.toJSON(b, ids)).toEqual({ $node: "b" });
    expect(FIELD_KINDS.node.toJSON({ name: "X" }, ids)).toBeNull();
    expect(FIELD_KINDS.node.toJSON("bird", ids)).toEqual({ $node: "bird" }); // a node choice's key
    expect(FIELD_KINDS.node.toJSON(null, ids)).toBeNull();
  });

  it("lists item by item, each through the item kind", () => {
    expect(kindOf([Vector2]).toJSON([new Vector2(1, 2), [3, 4]], ids)).toEqual([[1, 2], [3, 4]]);
    expect(kindOf([GameObject]).toJSON([b, null, "c"], ids)).toEqual([{ $node: "b" }, null, { $node: "c" }]);
    expect(kindOf([Color]).toJSON([new Color(1, 0, 0, 1)], ids)).toEqual(["#ff0000"]);
    expect(kindOf([AssetRef]).toJSON(["images/bird.png"], ids)).toEqual(["asset:images/bird.png"]);
    expect(kindOf([Number]).toJSON(undefined, ids)).toEqual([]);
  });
});

describe("sameness (a multi-selection's mixed)", () => {
  it("compares scene-file forms, node references by their id", () => {
    expect(FIELD_KINDS.vector3.same(new Vector3(1, 2, 3), [1, 2, 3], noNodeRefs)).toBe(true);
    expect(FIELD_KINDS.vector3.same(new Vector3(1, 2, 3), new Vector3(1, 2, 4), noNodeRefs)).toBe(false);
    expect(FIELD_KINDS.color.same(new Color(1, 0, 0, 1), Color.from("#ff0000"), noNodeRefs)).toBe(true);
    expect(FIELD_KINDS.node.same(b, "b", ids)).toBe(true);
    expect(FIELD_KINDS.node.same(b, c, ids)).toBe(false);
    expect(FIELD_KINDS.object.same({ a: 1 }, { a: 1 }, noNodeRefs)).toBe(true);
    expect(FIELD_KINDS.number.same(1, 2, noNodeRefs)).toBe(false);
  });

  it("rotations by the codec's sameness: q and -q, and float noise, are the same turn", () => {
    const q = Quaternion.euler(0, 0, 0.5);
    const rotation = FIELD_KINDS.quaternion;
    expect(rotation.same(q, new Quaternion(-q.x, -q.y, -q.z, -q.w), noNodeRefs)).toBe(true);
    expect(rotation.same(q, Quaternion.euler(0, 0, 0.5 + 1e-9), noNodeRefs)).toBe(true);
    expect(rotation.same(q, Quaternion.euler(0, 0, 0.51), noNodeRefs)).toBe(false);
    expect(rotation.same(null, q, noNodeRefs)).toBe(false);
    expect(rotation.same(null, undefined, noNodeRefs)).toBe(true);
  });

  it("lists item by item", () => {
    const nodes = kindOf([GameObject]);
    expect(nodes.same([b, c], ["b", "c"], ids)).toBe(true);
    expect(nodes.same([b, c], [b], ids)).toBe(false);
    const rotations = kindOf([Quaternion]);
    const q = Quaternion.euler(0.25, 0, 0);
    expect(rotations.same([q], [new Quaternion(-q.x, -q.y, -q.z, -q.w)], noNodeRefs)).toBe(true);
  });
});

describe("blank values, the unset rule and axis edits", () => {
  it("each kind's blank value for an empty list's Add", () => {
    expect(FIELD_KINDS.number.blank(null)).toBe(0);
    expect(FIELD_KINDS.integer.blank(null)).toBe(0);
    expect(FIELD_KINDS.boolean.blank(null)).toBe(false);
    expect(FIELD_KINDS.string.blank(null)).toBe("");
    expect(FIELD_KINDS.asset.blank(null)).toBe("");
    expect((FIELD_KINDS.color.blank(null) as Color).toHex()).toBe("#ffffff");
    expect(FIELD_KINDS.vector2.blank(null)).toEqual([0, 0]);
    expect(FIELD_KINDS.vector3.blank(null)).toEqual([0, 0, 0]);
    expect(FIELD_KINDS.quaternion.blank(null)).toEqual([0, 0, 0, 1]);
    expect(FIELD_KINDS.node.blank(null)).toBeNull();
    expect(FIELD_KINDS.object.blank(null)).toEqual({});
    expect(FIELD_KINDS.choice.blank([{ label: "slow", value: "slow" }])).toBe("slow");
    expect(FIELD_KINDS.choice.blank(null)).toBe("");
    expect(FIELD_KINDS.unknown.blank(null)).toBeNull();
  });

  it("only vectors may be unset (Auto); Set writes a 2D vector's 1, 1 and a 3D one's origin", () => {
    for (const k of Object.values(FIELD_KINDS)) expect(k.isUnset(null), k.name).toBe(k.name === "vector2" || k.name === "vector3");
    expect(FIELD_KINDS.vector2.isUnset(new Vector2(0, 0))).toBe(false);
    expect(FIELD_KINDS.vector2.explicit!()).toEqual([1, 1]);
    expect(FIELD_KINDS.vector3.explicit!()).toEqual([0, 0, 0]);
    expect(FIELD_KINDS.number.explicit).toBeUndefined();
  });

  it("vectors and rotations read and write one axis; other kinds have none", () => {
    const v = FIELD_KINDS.vector3.axes!;
    expect(v.read(new Vector3(1, 2, 3), "radians")).toEqual([1, 2, 3]);
    expect(v.write(new Vector3(1, 2, 3), 1, 7, "radians")).toEqual([1, 7, 3]);
    expect(FIELD_KINDS.vector2.axes!.write(null, 0, 5, "radians")).toEqual([5, 1]); // from what Set writes
    const r = FIELD_KINDS.quaternion.axes!;
    const q = r.write(null, 2, 0.5, "radians") as Quaternion;
    expect(q).toBeInstanceOf(Quaternion);
    expect(r.read(r.write(q, 0, 0.25, "radians"), "radians")).toEqual([0.25, 0, 0.5]);
    expect(r.read(Quaternion.rotateY(Math.PI / 2), "degrees")).toEqual([0, 90, 0]);
    for (const k of Object.values(FIELD_KINDS)) expect(!!k.axes, k.name).toBe(["vector2", "vector3", "quaternion"].includes(k.name));
  });
});
