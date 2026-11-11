// Rotation codecs and the rotation field (ADR 0165): stored quaternions shown as Euler radians or degrees
// (ZXY, ADR 0164) or raw x, y, z, w, with the "Euler hint" keeping angles as typed.
import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import { Quaternion } from "../../engine";
import { NumberInput } from "./NumberInput";
import { RotationField, rowRotationView, setRowRotationView, sharedAxes } from "./RotationField";
import { nextRotationView, quaternionJSON, rememberedEulerRadians, rotationCodec, rotationFrom, withRotationAxis } from "./rotationCodec";

const radians = rotationCodec("radians");
const degrees = rotationCodec("degrees");
const raw = rotationCodec("quaternion");

describe("rotation codecs", () => {
  it("reads and writes Euler radians, order ZXY", () => {
    const q = radians.write([0.25, 0.5, 0.75], Quaternion.identity);
    expect(q.equals(Quaternion.euler(0.25, 0.5, 0.75), 1e-9)).toBe(true);
    expect(radians.read(q)).toEqual([0.25, 0.5, 0.75]);
    // Without a hint, read from the quaternion, rounded.
    expect(radians.read(Quaternion.rotateY(Math.PI / 2))).toEqual([0, 1.570796, 0]);
  });

  it("reads and writes degrees, keeping the hint in radians", () => {
    const q = degrees.write([10, 200, 0], Quaternion.identity);
    expect(q.equals(Quaternion.euler((10 * Math.PI) / 180, (200 * Math.PI) / 180, 0), 1e-9)).toBe(true);
    expect(degrees.read(q)).toEqual([10, 200, 0]);
    expect(rememberedEulerRadians(q)![1]).toBeCloseTo((200 * Math.PI) / 180, 12);
    // The same rotation in radians shows the typed angles converted, not the -160° the quaternion reads as.
    expect(radians.read(q)[1]).toBeCloseTo((200 * Math.PI) / 180, 12);
    expect(degrees.read(Quaternion.rotateX(Math.PI / 6))).toEqual([30, 0, 0]);
  });

  it("shows angles past π as typed (the hint), for q and -q alike", () => {
    const q = radians.write([0, 3.5, 0], Quaternion.identity);
    expect(radians.read(q)).toEqual([0, 3.5, 0]);
    const negated = new Quaternion(-q.x, -q.y, -q.z, -q.w);
    expect(radians.read(negated)).toEqual([0, 3.5, 0]);
  });

  it("edits one axis keeping the others", () => {
    let q = withRotationAxis(null, "radians", 2, 0.5);
    q = withRotationAxis(q, "radians", 0, 0.25);
    expect(radians.read(q)).toEqual([0.25, 0, 0.5]);
    q = withRotationAxis(q, "degrees", 1, 90);
    expect(degrees.read(q).map((n) => Math.round(n * 1e3) / 1e3)).toEqual([14.324, 90, 28.648]);
  });

  it("four +π/2 yaw edits return to the start (and four +90° ones)", () => {
    const start = Quaternion.euler(0.1, 0.2, 0.3);
    let q = start.clone();
    for (let i = 0; i < 4; i++) q = withRotationAxis(q, "radians", 1, radians.read(q)[1] + Math.PI / 2);
    expect(radians.same(q, start)).toBe(true);
    for (let i = 0; i < 4; i++) q = withRotationAxis(q, "degrees", 1, degrees.read(q)[1] + 90);
    expect(degrees.same(q, start)).toBe(true);
  });

  it("the quaternion view shows x, y, z, w and normalizes on write", () => {
    expect(raw.read(Quaternion.identity)).toEqual([0, 0, 0, 1]);
    const q = withRotationAxis(Quaternion.identity, "quaternion", 1, 1);
    expect(raw.read(q)).toEqual([0, 0.7071068, 0, 0.7071068]);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
    // A zero quaternion can't be a rotation: the previous one is kept.
    const prev = Quaternion.rotateZ(1);
    expect(raw.write([0, 0, 0, 0], prev).equals(prev, 1e-12)).toBe(true);
  });

  it("writes the scene-file form: w ≥ 0, 7 decimals, no -0", () => {
    const json = radians.toJSON(new Quaternion(-0, -0.70710678, 0, -0.70710678));
    expect(json).toEqual([0, 0.7071068, 0, 0.7071068]);
    expect(Object.is((json as number[])[0], -0)).toBe(false);
    expect(quaternionJSON(new Quaternion(0, 0, 0, 2))).toEqual([0, 0, 0, 1]);
  });

  it("tells the same rotation apart from a different one", () => {
    const q = Quaternion.euler(0, 0, 0.5);
    expect(radians.same(q, new Quaternion(-q.x, -q.y, -q.z, -q.w))).toBe(true);
    expect(radians.same(q, Quaternion.euler(0, 0, 0.5 + 1e-8))).toBe(true);
    expect(radians.same(q, Quaternion.euler(0, 0, 0.51))).toBe(false);
  });

  it("takes field values as quaternions or Euler radians", () => {
    expect(rotationFrom([0, 0, 0, 1])!.equals(Quaternion.identity, 0)).toBe(true);
    const q = rotationFrom([0, 4, 0])!;
    expect(radians.read(q)).toEqual([0, 4, 0]);
    expect(rotationFrom("nope")).toBeNull();
  });

  it("cycles views radians → degrees → quaternion", () => {
    expect(nextRotationView("radians")).toBe("degrees");
    expect(nextRotationView("degrees")).toBe("quaternion");
    expect(nextRotationView("quaternion")).toBe("radians");
  });
});

/** The NumberInput boxes in a rendered RotationField. */
function boxes(node: VNode): VNode<{ value: number | null; label: string; onCommit: (n: number) => void }>[] {
  const found: VNode<{ value: number | null; label: string; onCommit: (n: number) => void }>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object" || !("props" in n)) return;
    const v = n as VNode<{ children?: unknown }>;
    if (v.type === NumberInput) found.push(v as never);
    walk(v.props.children);
  };
  walk(node);
  return found;
}

describe("RotationField", () => {
  it("shows a dash for axes that differ and commits each node's own rotation", () => {
    const a = Quaternion.euler(0, 0.5, 0), b = Quaternion.euler(0.25, 0.5, 0);
    let committed: Quaternion[] = [];
    const vnode = RotationField({ values: [a, b], label: "rotation", onCommit: (next) => (committed = next) }) as VNode;
    const inputs = boxes(vnode);
    expect(inputs.map((i) => i.props.value)).toEqual([null, 0.5, 0]);
    inputs[2].props.onCommit(1);
    expect(committed.map((q) => radians.read(q))).toEqual([
      [0, 0.5, 1],
      [0.25, 0.5, 1],
    ]);
  });

  it("shows four boxes in the quaternion view, and a row's toggle overrides the view for the session", () => {
    const q = Quaternion.identity;
    expect(boxes(RotationField({ values: [q], view: "quaternion", label: "r", onCommit: () => {} }) as VNode)).toHaveLength(4);
    expect(sharedAxes([[1, 2], [1, 3]])).toEqual([1, null]);
    expect(rowRotationView("test.Row.rotation", "radians")).toBe("radians");
    setRowRotationView("test.Row.rotation", "degrees");
    expect(rowRotationView("test.Row.rotation", "radians")).toBe("degrees");
    const shown = boxes(RotationField({ values: [Quaternion.rotateY(Math.PI / 2)], label: "r", toggleKey: "test.Row.rotation", onCommit: () => {} }) as VNode);
    expect(shown.map((i) => i.props.value)).toEqual([0, 90, 0]);
  });
});
