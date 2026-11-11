// ADR 0162 B5: LISTENER staging (architecture §3.5): the world to listener quaternion, the 0.001 rad threshold, snaps and the replay.
import { describe, expect, it } from "vitest";
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { ListenerStage, worldToListenerQuaternion } from "./listener";
import { ListenerFrame } from "./spatial";

interface Sent { q: number[]; ramp: number; snap: boolean }

function setup() {
  const sent: Sent[] = [];
  const stage = new ListenerStage({ listener: (qx, qy, qz, qw, ramp, snap) => void sent.push({ q: [qx, qy, qz, qw], ramp, snap }) });
  const frame = new ListenerFrame();
  const world = {} as World;
  const node = {} as GameObject;
  /** The head turned `deg` degrees to the left of -Z (about +Y), pitched up by `pitch` degrees. */
  const face = (deg: number, pitch = 0, n: GameObject = node) => {
    const a = (deg * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    frame.set(world, 1, n, { position: { x: 0, y: 0, z: 0 }, forward: { x: -Math.sin(a) * Math.cos(p), y: Math.sin(p), z: -Math.cos(a) * Math.cos(p) }, up: { x: 0, y: 1, z: 0 } }, 0.016);
  };
  return { sent, stage, frame, face, world, node };
}

describe("worldToListenerQuaternion", () => {
  it("facing -Z with +Y up is the identity", () => {
    const q: [number, number, number, number] = [9, 9, 9, 9];
    expect(worldToListenerQuaternion(0, 0, -1, 0, 1, 0, q)).toBe(true);
    expect(q.map((v) => v + 0)).toEqual([0, 0, 0, 1]);
  });

  it("turning 90 degrees left is a rotation of -90 degrees about +Y (world to listener)", () => {
    const q: [number, number, number, number] = [0, 0, 0, 1];
    worldToListenerQuaternion(-1, 0, 0, 0, 1, 0, q);
    expect(q[0]).toBeCloseTo(0, 6);
    expect(q[1]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(q[2]).toBeCloseTo(0, 6);
    expect(Math.abs(q[3])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("takes forward and up that aren't unit or perpendicular, and refuses a degenerate frame", () => {
    const q: [number, number, number, number] = [0, 0, 0, 1];
    expect(worldToListenerQuaternion(0, 0, -5, 0, 3, 0.5, q)).toBe(true);
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(worldToListenerQuaternion(0, 0, 0, 0, 1, 0, q)).toBe(false);
    expect(worldToListenerQuaternion(0, 1, 0, 0, 1, 0, q)).toBe(false);
    expect(worldToListenerQuaternion(NaN, 0, -1, 0, 1, 0, q)).toBe(false);
  });

  it("rotates a world direction to listener space as the quaternion says", () => {
    // A source straight ahead of a listener who turned 30 degrees left sits 30 degrees to its right (+X).
    const q: [number, number, number, number] = [0, 0, 0, 1];
    const a = (30 * Math.PI) / 180;
    worldToListenerQuaternion(-Math.sin(a), 0, -Math.cos(a), 0, 1, 0, q);
    const [x, y, z, w] = q;
    const v = [0, 0, -1];
    // v' = q v q*, by t = 2 q.xyz × v, v' = v + w t + q.xyz × t
    const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
    const r = [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
    expect(r[0]).toBeCloseTo(Math.sin(a), 6);
    expect(r[2]).toBeCloseTo(-Math.cos(a), 6);
  });
});

describe("ListenerStage", () => {
  it("sends nothing while the listener faces the identity, nothing without a World or a node", () => {
    const { sent, stage, frame, face } = setup();
    stage.stage(frame, 100); // no World yet
    face(0);
    stage.stage(frame, 100);
    expect(sent).toHaveLength(0);
    frame.node = null;
    face(45);
    frame.node = null;
    stage.stage(frame, 100);
    expect(sent).toHaveLength(0);
  });

  it("the first LISTENER snaps; a later turn ramps over the frame's rampFrames", () => {
    const { sent, stage, frame, face } = setup();
    face(20);
    stage.stage(frame, 2400);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.snap).toBe(true);
    face(25);
    stage.stage(frame, 2400);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ ramp: 2400, snap: false });
  });

  it("re-sends only past 0.001 rad", () => {
    const { sent, stage, frame, face } = setup();
    face(20);
    stage.stage(frame, 100);
    const rad = Math.PI / 180;
    face(20 + 0.0004 / rad); // 0.0004 rad
    stage.stage(frame, 100);
    expect(sent).toHaveLength(1);
    face(20 + 0.0012 / rad); // 0.0012 rad from the last sent
    stage.stage(frame, 100);
    expect(sent).toHaveLength(2);
    // Drift is measured from what was sent, not from the previous frame: many small steps add up.
    for (let k = 1; k <= 8; k++) {
      face(20 + 0.0012 / rad + (k * 0.0003) / rad);
      stage.stage(frame, 100);
    }
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it("a cut, or a new listener node, snaps", () => {
    const { sent, stage, frame, face } = setup();
    face(10);
    stage.stage(frame, 100);
    face(60);
    frame.cut = true;
    stage.stage(frame, 100);
    expect(sent[1]!.snap).toBe(true);
    face(90, 0, {} as GameObject); // another camera
    stage.stage(frame, 100);
    expect(sent[2]!.snap).toBe(true);
    face(95, 0, frame.node!);
    stage.stage(frame, 100);
    expect(sent[3]!.snap).toBe(false);
  });

  it("an ambisonic play sends LISTENER even if the rotation hasn't moved, once", () => {
    const { sent, stage, frame, face } = setup();
    face(0);
    stage.noteAmbisonicPlay();
    stage.stage(frame, 100);
    expect(sent).toHaveLength(1);
    stage.stage(frame, 100);
    expect(sent).toHaveLength(1);
    stage.noteAmbisonicPlay();
    stage.stage(frame, 100);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.snap).toBe(false);
  });

  it("keeps q on the last sent one's side of the sphere (no long way round)", () => {
    const { sent, stage, frame, face } = setup();
    face(170);
    stage.stage(frame, 100);
    face(-170);
    stage.stage(frame, 100);
    const a = sent[0]!.q;
    const b = sent[1]!.q;
    expect(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!).toBeGreaterThan(0);
  });

  it("replays the last rotation, snapped; nothing when none was sent", () => {
    const { stage, frame, face } = setup();
    const records: { off: number }[] = [];
    const builder = { record: (_size: number, write: (view: DataView, off: number) => number) => void records.push({ off: write(new DataView(new ArrayBuffer(64)), 0) }) };
    stage.replay(builder as never);
    expect(records).toHaveLength(0);
    face(30);
    stage.stage(frame, 100);
    stage.replay(builder as never);
    expect(records).toHaveLength(1);
    expect(records[0]!.off).toBe(36);
  });
});
