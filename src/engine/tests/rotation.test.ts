// ADR 0163, 0164: rotations follow Unity ECS's LocalTransform / LocalToWorld. Quaternions are the data; Euler
// angles (ZXY, yaw outermost, radians) build and describe them; Transform turns with rotate / rotateX/Y/Z.
// Coordinates are Unity's: left-handed, +Y up, +Z forward.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Quaternion, SceneManager, Vector3, type RotationOrder } from "../index";
import { migrateSceneFile, type SceneFile } from "../scene/SceneLoader";
import { rotationToQuaternion } from "../scene/rotationMigration";
import { mirrorField, migrateToUnityCoordinates } from "../scene/handednessMigration";

const D = Math.PI / 180; // degrees to radians, to keep the test angles readable

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
    const q = Quaternion.euler(20 * D, 30 * D, 40 * D);
    const expected = Quaternion.mul(Quaternion.mul(Quaternion.rotateY(30 * D), Quaternion.rotateX(20 * D)), Quaternion.rotateZ(40 * D));
    expectSameRotation(q, expected, 12);
    expectSameRotation(Quaternion.euler([20 * D, 30 * D, 40 * D]), q, 12);
    expectSameRotation(Quaternion.fromEuler(20 * D, 30 * D, 40 * D), q, 12);
  });

  it("round-trips through toEuler in every order, gimbal lock included", () => {
    const samples = [[10, 20, 30], [-170, 80, 45], [120, -60, -150], [0, 90, 0], [90, 0, 0], [0, 0, 90], [33, -90, 12], [45, 90, -30]];
    for (const order of ORDERS) {
      for (const [x, y, z] of samples) {
        const q = Quaternion.euler(x * D, y * D, z * D, order);
        const e = q.toEuler(order);
        expectSameRotation(Quaternion.euler(e.x, e.y, e.z, order), q, 9);
      }
    }
  });

  it("names the old engine order: what scene format 2 stored is ZYX", () => {
    for (const [x, y, z] of [[10, 20, 30], [-50, 30, 0], [170, -80, 5]]) expectSameRotation(Quaternion.euler(x * D, y * D, z * D, "ZYX"), legacyXYZ(x, y, z), 12);
  });

  it("reads eulerAngles back in [0, 2π)", () => {
    const e = Quaternion.euler(-18 * D, -90 * D, 270 * D).eulerAngles;
    expectVec(e, 342 * D, 270 * D, 270 * D, 6);
    const yaw = Quaternion.rotateY(200 * D).eulerAngles;
    expectVec(yaw, 0, 200 * D, 0, 6);
  });

  it("turns as Unity does with +Z forward: yaw + turns right, pitch + looks down", () => {
    expectVec(Quaternion.rotate(Quaternion.rotateY(Math.PI / 2), Vector3.forward), 1, 0, 0);
    expectVec(Quaternion.rotate(Quaternion.rotateX(Math.PI / 6), Vector3.forward), 0, -0.5, Math.sqrt(3) / 2);
    expectVec(Quaternion.rotate(Quaternion.rotateZ(Math.PI / 2), Vector3.right), 0, 1, 0);
    expectVec(Vector3.forward, 0, 0, 1);
  });
});

describe("Quaternion builders (ADR 0163)", () => {
  it("turns about an axis by the right hand, in degrees", () => {
    expectVec(Quaternion.rotate(Quaternion.axisAngle([0, 0, 2], Math.PI / 2), [1, 0, 0]), 0, 1, 0);
    expectVec(Quaternion.rotate(Quaternion.rotateY(Math.PI / 2), [0, 0, 1]), 1, 0, 0);
    expectSameRotation(Quaternion.axisAngle([0, 0, 0], 1), Quaternion.identity);
  });

  it("lookRotation points forward (+Z) along the direction with up kept up, as Unity's", () => {
    const q = Quaternion.lookRotation([1, 0, 0]);
    expectVec(Quaternion.rotate(q, [0, 0, 1]), 1, 0, 0);
    expectVec(Quaternion.rotate(q, [0, 1, 0]), 0, 1, 0);
    expectSameRotation(q, Quaternion.rotateY(Math.PI / 2));
    const down = Quaternion.lookRotation([0, -1, 1], [0, 1, 0]);
    expectVec(Quaternion.rotate(down, [0, 0, 1]), 0, -Math.SQRT1_2, Math.SQRT1_2);
    expectSameRotation(Quaternion.lookRotationSafe([0, 0, 0]), Quaternion.identity);
    expectVec(Quaternion.rotate(Quaternion.lookRotationSafe([0, 5, 0], [0, 1, 0]), [0, 0, 1]), 0, 1, 0);
  });

  it("composes, inverts, measures and interpolates", () => {
    const a = Quaternion.rotateY(30 * D), b = Quaternion.rotateY(90 * D);
    expectSameRotation(Quaternion.mul(a, Quaternion.inverse(a)), Quaternion.identity);
    expect(Quaternion.angle(a, b)).toBeCloseTo(60 * D, 6);
    expectSameRotation(Quaternion.slerp(a, b, 0.5), Quaternion.rotateY(60 * D));
    expectSameRotation(Quaternion.nlerp(a, b, 0), a);
    expect(Quaternion.slerp(a, b, 1).equals(b)).toBe(true);
    expect(new Quaternion(-b.x, -b.y, -b.z, -b.w).equals(b)).toBe(true);
    expect(JSON.stringify(Quaternion.identity)).toBe("[0,0,0,1]");
  });

  it("reads quaternions and Euler arrays with Quaternion.from", () => {
    expect(Quaternion.from([0, 0, 0, 1]).toArray()).toEqual([0, 0, 0, 1]);
    expectSameRotation(Quaternion.from([0, Math.PI / 2, 0]), Quaternion.rotateY(Math.PI / 2));
  });
});

describe("Transform turns (ADR 0163)", () => {
  it("four quarter turns by eulerAngles read-modify-write come back to the start", async () => {
    await Engine.create({ headless: true });
    const t = GameObject.create("turntable").transform!;
    t.rotation = Quaternion.rotateX(10 * D); // tilted, so x and z are in play
    const start = t.rotation.clone();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const e = t.eulerAngles;
      t.eulerAngles = { x: e.x, y: e.y + Math.PI / 2, z: e.z };
      seen.push(Math.round(t.eulerAngles.y / D));
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expectSameRotation(t.rotation, start);
  });

  it("four rotateY(π/2) calls come back to the start, about the parent's or the node's own axes", async () => {
    await Engine.create({ headless: true });
    for (const space of ["parent", "self"] as const) {
      const t = GameObject.create(`spin-${space}`).transform!;
      t.rotation = Quaternion.euler(25 * D, 40 * D, 5 * D);
      const start = t.rotation.clone();
      for (let i = 0; i < 4; i++) t.rotateY(Math.PI / 2, space);
      expectSameRotation(t.rotation, start);
    }
  });

  it("rotate turns about the parent's axes by default and the node's own with 'self'", async () => {
    await Engine.create({ headless: true });
    const q = (deg: number, axis: "X" | "Y" | "Z") => Quaternion[`rotate${axis}`](deg * D);
    const t = GameObject.create("tilted").transform!;
    t.rotation = q(90, "Z");
    t.rotateY(90 * D);
    expectSameRotation(t.rotation, Quaternion.mul(q(90, "Y"), q(90, "Z")));
    t.rotation = q(90, "Z");
    t.rotateY(90 * D, "self");
    expectSameRotation(t.rotation, Quaternion.mul(q(90, "Z"), q(90, "Y")));
    t.rotation = Quaternion.identity;
    t.rotate(Quaternion.axisAngle([1, 0, 0], 30 * D));
    expectSameRotation(t.rotation, q(30, "X"));
    t.rotation2D = Math.PI / 4;
    expect(t.rotation2D).toBeCloseTo(Math.PI / 4, 6);
    t.rotate2D(Math.PI);
    expect(t.rotation2D).toBeCloseTo(-3 * Math.PI / 4, 6);
  });

  it("localToWorld gives the world matrix, position, rotation and directions", async () => {
    await Engine.create({ headless: true });
    const parent = GameObject.create("parent");
    parent.transform!.position = [10, 0, 0];
    parent.transform!.rotation = Quaternion.rotateY(Math.PI / 2); // facing +X
    const child = GameObject.create("child");
    child.setParent(parent, { keepWorldTransform: false });
    child.transform!.position = [0, 0, 2]; // 2 m ahead of the parent
    child.transform!.scale = [2, 2, 2];
    const l2w = child.transform!.localToWorld;
    expectVec(l2w.position, 12, 0, 0);
    expectSameRotation(l2w.rotation, Quaternion.rotateY(Math.PI / 2));
    expectVec(l2w.forward, 1, 0, 0);
    expectVec(l2w.right, 0, 0, -1);
    expectVec(l2w.up, 0, 1, 0);
    expectVec(l2w.transformPoint([0, 0, 1]), 14, 0, 0);
    expectVec(l2w.inverseTransformPoint([14, 0, 0]), 0, 0, 1);
    expectVec(l2w.transformDirection([0, 0, 1]), 2, 0, 0);
    expectVec(l2w.inverseTransformDirection([2, 0, 0]), 0, 0, 1);
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
    const out = migrateSceneFile(structuredClone(v2)); // through format 4 (mirrored): undo the mirror to compare
    expect(out.format).toBe("myco.scene@4");
    const unmirror = (q: number[]) => [-q[0] + 0, -q[1] + 0, q[2], q[3]];
    for (const n of out.nodes) for (const c of n.components ?? []) if (Array.isArray(c.data?.rotation)) c.data!.rotation = unmirror(c.data!.rotation as number[]);
    for (const o of out.nodes[3].overrides!) {
      if (o.field === "rotation") o.value = unmirror(o.value as number[]);
      for (const n of o.addNodes ?? []) for (const c of n.components ?? []) c.data!.rotation = unmirror(c.data!.rotation as number[]);
    }
    const rot = (i: number) => out.nodes[i].components![0].data!.rotation as number[];
    expectSameRotation(Quaternion.from(rot(0)), legacyXYZ(10, 20, 30));
    expectSameRotation(Quaternion.from(rot(1)), Quaternion.rotateZ(45 * D));
    expect(rot(2)).toEqual([0, 0, 0, 1]);
    const overrides = out.nodes[3].overrides!;
    expectSameRotation(Quaternion.from(overrides[0].value as number[]), Quaternion.rotateY(120 * D));
    expect(overrides[1].value).toEqual([0, 1, 0]);
    expectSameRotation(Quaternion.from(overrides[2].addNodes![0].components![0].data!.rotation as number[]), legacyXYZ(-50, 30, 0));
    expect(rotationToQuaternion([0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(rotationToQuaternion("text")).toBe("text");
  });

  it("loads a version 2 scene mirrored into Unity's coordinates", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject({ "old.json": v2, "p.json": { format: "myco.scene@4", nodes: [{ id: "r" }] } }) });
    const scene = await SceneManager.load("old.json");
    const a = scene.find("A")!;
    const old = legacyXYZ(10, 20, 30);
    expectSameRotation(a.transform!.rotation, new Quaternion(-old.x, -old.y, old.z, old.w), 5);
    expectVec(a.transform!.position, 1, 2, -3);
  });
});

describe("scene format 4: Unity's coordinates (ADR 0164)", () => {
  /** A point turned by a rotation, in the old (right-handed) or new (mirrored) world. */
  const turn = (q: number[], p: number[]) => Quaternion.rotate(Quaternion.from(q), p);

  it("mirrors positions, rotations and built-in components' node-space vectors in z", () => {
    const q = Quaternion.euler(0.3, 0.7, -0.2).toArray();
    const v3: SceneFile = {
      format: "myco.scene@3",
      nodes: [
        {
          id: "a",
          components: [
            { type: "engine.Transform", data: { position: [1, 2, 3], rotation: q, scale: [1, 2, 3] } },
            { type: "engine.BoxCollider", data: { center: [0, 0, 4], size: [1, 2, 3] } },
            { type: "engine.HingeJoint", data: { anchor: [0, 1, 2], axis: [0, 0, 1], limits: [-30, 30] } },
            { type: "engine.WaterSurface", data: { waves: [{ direction: 30, amplitude: 1 }] } },
            { type: "game.Thing", data: { center: [0, 0, 5] } },
            { type: "engine.AudioSource", data: { clip: "asset:amb.wav", ambisonicYaw: 30, minDistance: 2 } },
          ],
        },
        { id: "i", prefab: "p.json", overrides: [{ component: "engine.Transform", field: "position", value: [0, 0, 7] }, { component: "engine.AudioReverbZone", field: "center", value: [1, 1, 1] }] },
      ],
    };
    const out = migrateToUnityCoordinates(structuredClone(v3));
    const [t, box, hinge, water, game, source] = out.nodes[0].components!;
    expect(t.data!.position).toEqual([1, 2, -3]);
    expect(t.data!.scale).toEqual([1, 2, 3]);
    // The same picture: a point the old rotation sent to p now goes to p with z negated.
    const before = turn(q, [1, 2, 3]), after = turn(t.data!.rotation as number[], [1, 2, -3]);
    expectVec(after, before.x, before.y, -before.z, 6);
    expect(box.data).toEqual({ center: [0, 0, -4], size: [1, 2, 3] });
    expect(hinge.data).toEqual({ anchor: [0, 1, -2], axis: [0, 0, -1], limits: [-30, 30] });
    expect(water.data).toEqual({ waves: [{ direction: -30, amplitude: 1 }] });
    expect(game.data).toEqual({ center: [0, 0, 5] }); // script fields aren't known here
    // An ambisonic clip's yaw turned left for +30 then; +30 now turns right, so the same sound is -30.
    expect(source.data).toEqual({ clip: "asset:amb.wav", ambisonicYaw: -30, minDistance: 2 });
    expect(mirrorField("engine.AudioSource", "ambisonicYaw", -180)).toBe(180);
    expect(out.nodes[1].overrides![0].value).toEqual([0, 0, -7]);
    expect(out.nodes[1].overrides![1].value).toEqual([1, 1, -1]);
    expect(mirrorField("engine.Transform", "rotation", [0, 0, 0.6, 0.8])).toEqual([0, 0, 0.6, 0.8]); // 2D turns unchanged
  });

  it("reads hand-written Euler rotations in scene files as degrees", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject({ "s.json": { format: "myco.scene@4", nodes: [{ id: "n", name: "N", components: [{ type: "engine.Transform", data: { rotation: [0, 90, 0] } }] }, { id: "m", name: "M", components: [{ type: "engine.Transform", data: { rotation: 45 } }] }] } }) });
    const scene = await SceneManager.load("s.json");
    expectSameRotation(scene.find("N")!.transform!.rotation, Quaternion.rotateY(Math.PI / 2), 6);
    expect(scene.find("M")!.transform!.rotation2D).toBeCloseTo(Math.PI / 4, 6);
  });
});
