// The 2D frame (ADR 0301): a world matrix read as position, angle, signed scale and a mirrored flag, and its
// inverse that writes a pose back keeping the node's mirroring. Random poses, mirrored ones included, against
// the engine's own world matrices.
import { describe, expect, it } from "vitest";
import { Engine, GameObject } from "../../myco";
import { frame2D, frame2DFromMatrix, frame2DOf, frameDirection, frameToLocal, frameToWorld, localAngle2D } from "./frame2d";

const close = (a: readonly number[], b: readonly number[], digits = 5) => a.forEach((v, i) => expect(v, `${i}: ${a} vs ${b}`).toBeCloseTo(b[i], digits));

/** A small seeded random source, so a failing case can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo: number, hi: number) => lo + (hi - lo) * next();
  const scale = () => range(0.3, 2.5) * (next() < 0.35 ? -1 : 1);
  return { next, range, scale };
}

/** A node at a random 2D pose (often mirrored), under a random parent half the time. */
function placed(r: ReturnType<typeof random>) {
  const parent = r.next() < 0.5 ? GameObject.create("parent") : null;
  if (parent) {
    parent.transform!.position.set(r.range(-3, 3), r.range(-3, 3), 0);
    parent.transform!.rotation2D = r.range(-Math.PI, Math.PI);
    const k = r.scale(); // uniform, so a turned child isn't sheared
    parent.transform!.scale.set(k, Math.abs(k) * (r.next() < 0.3 ? -1 : 1), 1);
  }
  const node = GameObject.create("node", { parent });
  node.transform!.position.set(r.range(-3, 3), r.range(-3, 3), r.range(-1, 1));
  node.transform!.rotation2D = r.range(-Math.PI, Math.PI);
  node.transform!.scale.set(r.scale(), r.scale(), 1);
  return node;
}

/** The node, or its parent when 'placed' made one. */
const top = (node: GameObject) => (node.parent?.name === "parent" ? node.parent : node);

const worldPoint = (node: GameObject, x: number, y: number) => {
  const p = node.transform!.localToWorld.transformPoint({ x, y, z: 0 });
  return [p.x, p.y, p.z];
};

describe("a node's 2D frame (ADR 0301)", () => {
  it("reads a mirrored node as mirrored on x, not as turned half a turn", () => {
    const m = (a: number, b: number, c: number, d: number) => [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    const mirrored = frame2DFromMatrix(m(-1, 0, 0, 1));
    expect(mirrored).toMatchObject({ position: [5, 6, 7], scale: [-1, 1], mirrored: true });
    expect(mirrored.angle).toBeCloseTo(0);
    const flippedY = frame2DFromMatrix(m(1, 0, 0, -1)); // the same matrix as R(π) · diag(-1, 1)
    expect(flippedY.mirrored).toBe(true);
    expect(Math.abs(flippedY.angle)).toBeCloseTo(Math.PI);
    close(flippedY.scale, [-1, 1]);
    const plain = frame2DFromMatrix(m(0, 2, -3, 0)); // turned a quarter, scaled (2, 3)
    expect(plain.mirrored).toBe(false);
    expect(plain.angle).toBeCloseTo(Math.PI / 2);
    close(plain.scale, [2, 3]);
  });

  it("puts every local point where the node's world matrix puts it, and maps world points back", async () => {
    const engine = await Engine.create({ headless: true });
    const r = random(301);
    for (let n = 0; n < 60; n++) {
      const node = placed(r);
      const f = frame2DOf(node);
      const m = node.transform!.localToWorld.value;
      expect(f.mirrored).toBe(m[0] * m[5] - m[1] * m[4] < 0);
      for (let k = 0; k < 4; k++) {
        const p: [number, number] = [r.range(-2, 2), r.range(-2, 2)];
        close(frameToWorld(f, p), worldPoint(node, p[0], p[1]));
        close(frameToLocal(f, frameToWorld(f, p)), p);
        const o = worldPoint(node, 0, 0), q = worldPoint(node, p[0], p[1]);
        close(frameDirection(f, p), [q[0] - o[0], q[1] - o[1]]);
      }
      GameObject.destroy(top(node));
    }
    engine.dispose();
  });

  it("writes an angle back keeping the node's scale and mirroring (Transform.worldRotation2D)", async () => {
    const engine = await Engine.create({ headless: true });
    const r = random(7);
    for (let n = 0; n < 60; n++) {
      const node = placed(r);
      const before = frame2DOf(node);
      const scale = [node.transform!.scale.x, node.transform!.scale.y];
      const angle = r.range(-Math.PI, Math.PI);
      node.transform!.worldRotation2D = angle;
      const after = frame2DOf(node);
      expect(node.transform!.worldRotation2D).toBeCloseTo(angle, 4);
      expect(Math.cos(after.angle - angle)).toBeCloseTo(1, 6);
      close(after.scale, before.scale, 4);
      expect(after.mirrored).toBe(before.mirrored);
      close([node.transform!.scale.x, node.transform!.scale.y], scale); // the local scale is untouched
      GameObject.destroy(top(node));
    }
    engine.dispose();
  });

  it("localAngle2D undoes a parent and the node's local scale", () => {
    // No parent, local scale (1, -1): the frame reads angle π + φ and scale (-1, 1); the local turn is φ.
    expect(localAngle2D(Math.PI + 0.5, [-1, 1], null, 0, [1, -1])).toBeCloseTo(0.5);
    expect(localAngle2D(0.5, [-1, 1], null, 0, [-1, 1])).toBeCloseTo(0.5);
    // A parent turned 0.3 (column-major): the child's local turn is the rest.
    const c = Math.cos(0.3), s = Math.sin(0.3);
    expect(localAngle2D(1, [1, 1], [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0, [1, 1])).toBeCloseTo(0.7);
    expect(frame2D([0, 0, 0], 0, [-2, 1]).mirrored).toBe(true);
  });
});
