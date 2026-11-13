// The listener's rotation for the core (ADR 0162; architecture §3.5; C4, S2, S19, R3). Last in the frame (after the fx
// staging), in the World with the view only: LISTENER (the world → listener quaternion, the frame's `rampFrames`, `snap`
// on a camera cut) when the rotation moved more than 0.001 rad, on a cut, and on the first ambisonic play, in the same
// BATCH as the frame's direction changes so clips and point voices turn together. A hard rebuild replays the last
// rotation, snapped, after the bus lanes and MASTER (C10's order).
//
// **Axes (S2).** The core's axes are right-handed (listener space: +X right, +Y up, forward -Z); the core owns the
// engine → AmbiX map, `(X, Y, Z)_ambix = (-z, -x, +y)_engine` (`audio-dsp` `quat_to_ambix`), and applies
// R = R(q) · Rz(yaw) to each ambisonic voice. The engine's world is left-handed with +Z forward (ADR 0164), so main
// mirrors it into the core's axes first (z negated: a world vector (x, y, z) is (x, y, -z) there, which puts an
// ambisonic clip's front on world +Z). `q` is then the rotation whose matrix has the rows (right, up, -forward) of
// the mirrored listener frame: it takes a mirrored world vector to listener space, which clip rotation applies directly.
//
// **Snaps.** The first LISTENER snaps (the core is at the identity until then; a ramp would sweep the whole scene
// round), as does a frame with `ListenerFrame.cut`, a change of the listener's node or World (a camera cut, a scene
// start), and the replay.
//
// D3 owns the listener's velocity (`ListenerFrame.vel*`, `AudioListener.setVelocity`): it is not part of LISTENER (the
// core has no use for it; Doppler is main's). The seam for it is `ListenerStage.stage`: it reads the frame's pose only,
// and a velocity-driven teleport reaches it as `frame.cut` (D3 sets it in the Doppler pass, which runs before this one).
import { ASAP, LISTENER_FIXED_END, LISTENER_FLAGS_SNAP, writeListener } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";
import type { ListenerFrame } from "./spatial";

/** @internal C4: LISTENER is re-sent when the rotation moves more than this, radians. */
export const LISTENER_ROTATION_THRESHOLD = 0.001;

/** |dot| of two unit quaternions above this is a rotation of at most the threshold (`2·acos|dot|`). */
const COS_HALF_THRESHOLD = Math.cos(LISTENER_ROTATION_THRESHOLD / 2);

/**
 * @internal The world → listener quaternion `(x, y, z, w)` of a frame with `forward` and `up` in engine world axes (not
 * necessarily unit or perpendicular: they are orthonormalised as `listenerSpaceDirection` does), in the core's
 * right-handed axes (the world mirrored in z, see S2 above), written to `out`. False when the frame is
 * degenerate (zero forward, or forward parallel to up) or not finite; `out` is untouched then.
 */
export function worldToListenerQuaternion(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number, out: [number, number, number, number]): boolean {
  // Into the core's right-handed axes (ADR 0164).
  fz = -fz;
  uz = -uz;
  const fl = Math.hypot(fx, fy, fz);
  if (!(fl > 0) || !Number.isFinite(fl)) return false;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward × up
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  const rl = Math.hypot(rx, ry, rz);
  if (!(rl > 1e-9) || !Number.isFinite(rl)) return false;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up' = right × forward
  const vx = ry * fz - rz * fy;
  const vy = rz * fx - rx * fz;
  const vz = rx * fy - ry * fx;
  // The matrix with rows (right, up', -forward) takes a mirrored world vector to listener space; its quaternion (Shepperd).
  const m00 = rx, m01 = ry, m02 = rz;
  const m10 = vx, m11 = vy, m12 = vz;
  const m20 = -fx, m21 = -fy, m22 = -fz;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  out[0] = x / n;
  out[1] = y / n;
  out[2] = z / n;
  out[3] = w / n;
  return true;
}

/** @internal LISTENER staging (constructed by the core backend). */
export class ListenerStage {
  /** True once a LISTENER went to this core (the replay restores it). */
  sent = false;
  /** The rotation last sent (world → listener, unit quaternion). */
  qx = 0;
  qy = 0;
  qz = 0;
  qw = 1;
  /** An ambisonic voice started since the last `stage` (C4: LISTENER goes even if the rotation hasn't moved). */
  private ambisonicPlayed = false;
  /** The node and World key of the last frame that staged, to see a camera cut or a scene start. */
  private lastNode: unknown = null;
  private lastWorldKey = 0;
  /** Scratch for the frame's quaternion (a frame allocates nothing). */
  private readonly q: [number, number, number, number] = [0, 0, 0, 1];

  constructor(private readonly writer: Pick<CommandWriter, "listener">) {}

  /**
   * The frame's LISTENER (B5): from `frame`'s pose, when the rotation moved past the threshold, on `frame.cut` (snap),
   * or when an ambisonic play asked for it; over `rampFrames`. Nothing without a World with the view and a listener
   * (S19), or on a degenerate pose.
   */
  stage(frame: ListenerFrame, rampFrames: number): void {
    if (frame.world === null || frame.node === null) return;
    const q = this.q;
    if (!worldToListenerQuaternion(frame.fwdX, frame.fwdY, frame.fwdZ, frame.upX, frame.upY, frame.upZ, q)) return;
    // q and -q are one rotation: take the one on the last sent one's side, so the core's ramp goes the short way.
    let dot = q[0] * this.qx + q[1] * this.qy + q[2] * this.qz + q[3] * this.qw;
    if (dot < 0) {
      q[0] = -q[0];
      q[1] = -q[1];
      q[2] = -q[2];
      q[3] = -q[3];
      dot = -dot;
    }
    const jumped = frame.cut || (this.sent && (frame.node !== this.lastNode || frame.worldKey !== this.lastWorldKey));
    this.lastNode = frame.node;
    this.lastWorldKey = frame.worldKey;
    if (dot >= COS_HALF_THRESHOLD && !jumped && !this.ambisonicPlayed) return;
    const snap = !this.sent || jumped;
    this.ambisonicPlayed = false;
    this.writer.listener(q[0], q[1], q[2], q[3], rampFrames, snap);
    this.noteSent(q[0], q[1], q[2], q[3]);
  }

  /** An ambisonic voice is about to play: the next `stage` sends LISTENER even if the rotation hasn't moved (C4). */
  noteAmbisonicPlay(): void {
    this.ambisonicPlayed = true;
  }

  /** Records what `stage` sent. */
  private noteSent(qx: number, qy: number, qz: number, qw: number): void {
    this.sent = true;
    this.qx = qx;
    this.qy = qy;
    this.qz = qz;
    this.qw = qw;
  }

  /** A hard rebuild: the last rotation, snapped, after the bus lanes and MASTER (C10). Nothing if none was ever sent. */
  replay(b: ReplayBuilder): void {
    if (!this.sent) return;
    const { qx, qy, qz, qw } = this;
    b.record(LISTENER_FIXED_END, (view, off) => writeListener(view, off, { voiceId: 0, frameOffset: ASAP, qx, qy, qz, qw, rampFrames: 0, flags: LISTENER_FLAGS_SNAP }));
  }
}
