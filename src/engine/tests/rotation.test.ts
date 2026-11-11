// ADR 0163: rotations follow Unity ECS's LocalTransform / LocalToWorld. Quaternions are the data; Euler
// angles (ZXY, yaw outermost) build and describe them; Transform turns with rotate / rotateX/Y/Z.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Quaternion, SceneManager, Vector3, type RotationOrder } from "../index";
import { migrateSceneFile, type SceneFile } from "../scene/SceneLoader";
import { rotationToQuaternion } from "../scene/rotationMigration";

const ORDERS: RotationOrder[] = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];

/** The engine's Euler formula before ADR 0163: q = qX · qY · qZ. */
function legacyXYZ(xDeg: number, yDeg: number, zDeg: number): Quaternion {
  const r = Math.PI / 360;
  const c1 = Math.cos(xDeg * r), c2 = Math.cos(yDeg * r), c3 = Math.cos(zDeg * r);
  const s1 = Math.sin(xDeg * r), s2 = Math.sin(yDeg * r), s3 = Math.sin(zDeg * r);
  return new Quaternion(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
}

const expectSameRotation = (a: Quaternion, b: Quaternion, digits = 6) => expect(Math.abs(Quaternion.dot(a, b))).toBeCloseTo(1, digits);
const expectVec = (v: Vector3, x: number, y: number, z: number, digits = 5) => {
  expect(v.x).toBeCloseTo(x, digits);
  expect(v.y).toBeCloseTo(y, digits);
  expect(v.z).toBeCloseTo(z, digits);
};

afterEach(() => Assets.clearSources());

describe("Quaternion Euler angles (ADR 0163)", () => {
  it("defaults to ZXY: roll, then pitch, then yaw, about fixed axes (q = qY · qX · qZ)", () => {
    const q = Quaternion.euler(20, 30, 40);
    const expected = Quaternion.mul(Quaternion.mul(Quaternion.rotateY(30), Quaternion.rotateX(20)), Quaternion.rotateZ(40));
    expectSameRotation(q, expected, 12);
    expectSameRotation(Quaternion.euler([20, 30, 40]), q, 12);
    expectSameRotation(Quaternion.fromEuler(20, 30, 40), q, 12);
  });

  it("round-trips through toEuler in every order, gimbal lock included", () => {
    const samples = [[10, 20, 30], [-170, 80, 45], [120, -60, -150], [0, 90, 0], [90, 0, 0], [0, 0, 90], [33, -90, 12], [45, 90, -30]];
    for (const order of ORDERS) {
      for (const [x, y, z] of samples) {
        const q = Quaternion.euler(x, y, z, order);
        const e = q.toEuler(order);
        expectSameRotation(Quaternion.euler(e.x, e.y, e.z, order), q, 9);
      }
    }
  });

  it("names the old engine order: what scene format 2 stored is ZYX", () => {
    for (const [x, y, z] of [[10, 20, 30], [-50, 30, 0], [170, -80, 5]]) expectSameRotation(Quaternion.euler(x, y, z, "ZYX"), legacyXYZ(x, y, z), 12);
  });

  it("reads eulerAngles back in [0, 360), as Unity does", () => {
    const e = Quaternion.euler(-18, -90, 270).eulerAngles;
    expectVec(e, 342, 270, 270, 6);
    const yaw = Quaternion.rotateY(200).eulerAngles;
    expectVec(yaw, 0, 200, 0, 6);
  });
});

describe("Quaternion builders (ADR 0163)", () => {
  it("turns about an axis by the right hand, in degrees", () => {
    expectVec(Quaternion.rotate(Quaternion.axisAngle([0, 0, 2], 90), [1, 0, 0]), 0, 1, 0);
    expectVec(Quaternion.rotate(Quaternion.rotateY(90), [0, 0, -1]), -1, 0, 0);
    expectSameRotation(Quaternion.axisAngle([0, 0, 0], 45), Quaternion.identity);
  });

  it("lookRotation points forward (-Z) along the direction with up kept up", () => {
    const q = Quaternion.lookRotation([1, 0, 0]);
    expectVec(Quaternion.rotate(q, [0, 0, -1]), 1, 0, 0);
    expectVec(Quaternion.rotate(q, [0, 1, 0]), 0, 1, 0);
    const down = Quaternion.lookRotation([0, -1, -1], [0, 1, 0]);
    expectVec(Quaternion.rotate(down, [0, 0, -1]), 0, -Math.SQRT1_2, -Math.SQRT1_2);
    expectSameRotation(Quaternion.lookRotationSafe([0, 0, 0]), Quaternion.identity);
    expectVec(Quaternion.rotate(Quaternion.lookRotationSafe([0, 5, 0], [0, 1, 0]), [0, 0, -1]), 0, 1, 0);
  });

  it("composes, inverts, measures and interpolates", () => {
    const a = Quaternion.rotateY(30), b = Quaternion.rotateY(90);
    expectSameRotation(Quaternion.mul(a, Quaternion.inverse(a)), Quaternion.identity);
    expect(Quaternion.angle(a, b)).toBeCloseTo(60, 6);
    expectSameRotation(Quaternion.slerp(a, b, 0.5), Quaternion.rotateY(60));
    expectSameRotation(Quaternion.nlerp(a, b, 0), a);
    expect(Quaternion.slerp(a, b, 1).equals(b)).toBe(true);
    expect(new Quaternion(-b.x, -b.y, -b.z, -b.w).equals(b)).toBe(true);
    expect(JSON.stringify(Quaternion.identity)).toBe("[0,0,0,1]");
  });

  it("reads quaternions and Euler arrays with Quaternion.from", () => {
    expect(Quaternion.from([0, 0, 0, 1]).toArray()).toEqual([0, 0, 0, 1]);
    expectSameRotation(Quaternion.from([0, 90, 0]), Quaternion.rotateY(90));
  });
});

describe("Transform turns (ADR 0163)", () => {
  it("four 90-degree turns by eulerAngles read-modify-write come back to the start", async () => {
    await Engine.create({ headless: true });
    const t = GameObject.create("turntable").transform!;
    t.rotation = Quaternion.rotateX(10); // tilted, so x and z are in play
    const start = t.rotation.clone();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const e = t.eulerAngles;
      t.eulerAngles = { x: e.x, y: e.y + 90, z: e.z };
      seen.push(Math.round(t.eulerAngles.y));
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expectSameRotation(t.rotation, start);
  });

  it("four rotateY(90) calls come back to the start, about the parent's or the node's own axes", async () => {
    await Engine.create({ headless: true });
    for (const space of ["parent", "self"] as const) {
      const t = GameObject.create(`spin-${space}`).transform!;
      t.rotation = Quaternion.euler(25, 40, 5);
      const start = t.rotation.clone();
      for (let i = 0; i < 4; i++) t.rotateY(90, space);
      expectSameRotation(t.rotation, start);
    }
  });

  it("rotate turns about the parent's axes by default and the node's own with 'self'", async () => {
    await Engine.create({ headless: true });
    const t = GameObject.create("tilted").transform!;
    t.rotation = Quaternion.rotateZ(90); // the node's own Y now points along the parent's -X
    t.rotateY(90);
    expectSameRotation(t.rotation, Quaternion.mul(Quaternion.rotateY(90), Quaternion.rotateZ(90)));
    t.rotation = Quaternion.rotateZ(90);
    t.rotateY(90, "self");
    expectSameRotation(t.rotation, Quaternion.mul(Quaternion.rotateZ(90), Quaternion.rotateY(90)));
    t.rotation = Quaternion.identity;
    t.rotate(Quaternion.axisAngle([1, 0, 0], 30));
    expectSameRotation(t.rotation, Quaternion.rotateX(30));
  });

  it("localToWorld gives the world matrix, position, rotation and directions", async () => {
    await Engine.create({ headless: true });
    const parent = GameObject.create("parent");
    parent.transform!.position = [10, 0, 0];
    parent.transform!.rotation = Quaternion.rotateY(90);
    const child = GameObject.create("child");
    child.setParent(parent, { keepWorldTransform: false });
    child.transform!.position = [0, 0, -2]; // 2 m ahead of the parent
    child.transform!.scale = [2, 2, 2];
    const l2w = child.transform!.localToWorld;
    expectVec(l2w.position, 8, 0, 0);
    expectSameRotation(l2w.rotation, Quaternion.rotateY(90));
    expectVec(l2w.forward, -1, 0, 0);
    expectVec(l2w.right, 0, 0, -1);
    expectVec(l2w.up, 0, 1, 0);
    expectVec(l2w.transformPoint([0, 0, -1]), 6, 0, 0);
    expectVec(l2w.inverseTransformPoint([6, 0, 0]), 0, 0, -1);
    expectVec(l2w.transformDirection([0, 0, -1]), -2, 0, 0);
    expectVec(l2w.inverseTransformDirection([-2, 0, 0]), 0, 0, -1);
    expect(l2w.value).toHaveLength(16);
  });
});

describe("scene format 3: quaternion rotations (ADR 0163)", () => {
  const v2: SceneFile = {
    format: "myco.scene@2",
    nodes: [
      { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [1, 2, 3], rotation: [10, 20, 30] } }] },
      { id: "flat", components: [{ type: "engine.Transform", data: { rotation: 45 } }] },
      { id: "q", components: [{ type: "engine.Transform", data: { rotation: [0, 0, 0, 1] } }] },
      {
        id: "inst",
        prefab: "p.json",
        overrides: [
          { component: "engine.Transform", field: "rotation", value: [0, 120, 0] },
          { component: "engine.Transform", field: "position", value: [0, 1, 0] },
          { addNodes: [{ id: "extra", components: [{ type: "engine.Transform", data: { rotation: [-50, 30, 0] } }] }] },
        ],
      },
    ],
  };

  it("converts every version 2 Transform rotation to the quaternion it meant", () => {
    const out = migrateSceneFile(structuredClone(v2));
    expect(out.format).toBe("myco.scene@3");
    const rot = (i: number) => out.nodes[i].components![0].data!.rotation as number[];
    expectSameRotation(Quaternion.from(rot(0)), legacyXYZ(10, 20, 30));
    expectSameRotation(Quaternion.from(rot(1)), Quaternion.rotateZ(45));
    expect(rot(2)).toEqual([0, 0, 0, 1]);
    const overrides = out.nodes[3].overrides!;
    expectSameRotation(Quaternion.from(overrides[0].value as number[]), Quaternion.rotateY(120));
    expect(overrides[1].value).toEqual([0, 1, 0]);
    expectSameRotation(Quaternion.from(overrides[2].addNodes![0].components![0].data!.rotation as number[]), legacyXYZ(-50, 30, 0));
    expect(rotationToQuaternion([0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(rotationToQuaternion("text")).toBe("text");
  });

  it("loads a version 2 scene facing exactly as before", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject({ "old.json": v2, "p.json": { format: "myco.scene@3", nodes: [{ id: "r" }] } }) });
    const scene = await SceneManager.load("old.json");
    const a = scene.find("A")!;
    expectSameRotation(a.transform!.rotation, legacyXYZ(10, 20, 30), 5);
  });
});
