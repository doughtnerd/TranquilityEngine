// ADR 0312: a layout's predicted plan owns one order of predicted values for picking them from a
// received state, reading and writing a ghost's node and comparing a prediction with the server's;
// and it compares rotations as rotations.
import { describe, expect, it } from "vitest";
import { GameBehavior, behavior, defineComponent, f32, field, i32, replicate } from "../index";
import { World } from "../core/World";
import { Replicated } from "../net/Replicated";
import { ROTATION_TOLERANCE, bind, layoutOf, predictedPlan, type LayoutSpec } from "../net/replication/layout";
import { GameObject } from "../scene/GameObject";

const Body = defineComponent("test.plan.Body", { vx: f32, hits: i32, other: f32 });
replicate(Body, { predicted: ["hits", "vx"] }); // listed out of order: the plan follows the layout

@behavior("test.plan.Tank")
class Tank extends GameBehavior {
  @field(Number, { predicted: true }) fuel = 0;
  @field(Boolean, { predicted: true }) boosting = false;
}

const spec: LayoutSpec = {
  transform: true,
  data: [{ id: "test.plan.Body", fields: [{ kind: "f32", quantize: 0 }, { kind: "i32", quantize: 0 }, { kind: "f32", quantize: 0 }] }],
  behaviors: [{ id: "test.plan.Tank", index: 0, fields: [{ kind: "f32", quantize: 0 }, { kind: "u8", quantize: 0 }] }],
};

/** A full received state: ownerId, mode, position, rotation (a unit quaternion), scale, Body's vx/hits/other, Tank's fuel/boosting. */
function state(q: readonly number[] = [0, Math.sin(0.3), 0, Math.cos(0.3)]): number[] {
  return [3, 1, 1.5, -2, 0.25, ...q, 1, 2, 3, 0.75, 9, 123, 40.5, 1];
}

function ghost() {
  const world = new World("runtime", {}, { name: "Plan", tags: ["client"] });
  const node = World._runIn(world, () => {
    const n = GameObject.create("Ghost");
    n.addBehavior(Tank);
    return n;
  });
  const rep = World._runIn(world, () => node.addBehavior(Replicated));
  return { world, node, binding: bind(layoutOf(spec), node, rep) };
}

describe("the predicted plan (ADR 0312)", () => {
  it("picks, writes and reads the predicted values in one order", () => {
    const plan = predictedPlan(layoutOf(spec));
    const picked = plan.pick(state());
    // Transform (10), then Body's vx and hits in layout order (not "other"), then Tank's fields.
    expect(picked).toEqual([1.5, -2, 0.25, 0, Math.sin(0.3), 0, Math.cos(0.3), 1, 2, 3, 0.75, 9, 40.5, 1]);
    expect(plan.size).toBe(picked.length);
    expect(plan.hasTransform).toBe(true);

    const { node, binding } = ghost();
    plan.apply(binding, picked);
    expect(node.getData(Body)).toMatchObject({ vx: 0.75, hits: 9, other: 0 });
    expect(node.getBehavior(Tank)).toMatchObject({ fuel: 40.5, boosting: true });
    expect(plan.error(plan.read(binding), picked)).toBe(0);
  });

  it("compares rotations as rotations: q and -q agree, and the error is the angle between", () => {
    const plan = predictedPlan(layoutOf(spec));
    const q = [0, Math.sin(0.3), 0, Math.cos(0.3)];
    expect(plan.error(plan.pick(state(q)), plan.pick(state(q.map((v) => -v))))).toBe(0);
    // Within quantization: half a rotation step on every component.
    expect(plan.error(plan.pick(state(q)), plan.pick(state(q.map((v) => v + 0.00025))))).toBe(0);
    // Turned 0.1 rad further about the same axis (and negated): the error is 0.1 rad.
    const turned = [0, -Math.sin(0.35), 0, -Math.cos(0.35)];
    expect(plan.error(plan.pick(state(q)), plan.pick(state(turned)))).toBeCloseTo(0.1, 6);
    expect(ROTATION_TOLERANCE).toBeLessThan(0.01);
  });

  it("compares other values within their tolerance, integers exactly", () => {
    const plan = predictedPlan(layoutOf(spec));
    const a = state();
    const b = [...a];
    b[12] += 1e-4; // Body.vx, unquantized f32: relative 1e-5 of at least 1
    expect(plan.error(plan.pick(a), plan.pick(b))).toBeCloseTo(1e-4, 6);
    const c = [...a];
    c[13] = 10; // Body.hits, i32: exact
    expect(plan.error(plan.pick(a), plan.pick(c))).toBe(1);
    const d = [...a];
    d[14] = 999; // Body.other isn't predicted
    expect(plan.error(plan.pick(a), plan.pick(d))).toBe(0);
  });
});
