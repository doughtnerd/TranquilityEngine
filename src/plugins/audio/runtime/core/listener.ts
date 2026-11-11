// The listener's rotation for the core (ADR 0162; architecture §3.5; C4, S2, S19, R3). Last in the frame (after the fx
// staging), in the World with the view only: LISTENER (the world → listener quaternion, the frame's `rampFrames`, `snap`
// on a camera cut) when the rotation moved more than 0.001 rad, on a cut, and on the first ambisonic play, in the same
// BATCH as the frame's direction changes so clips and point voices turn together. A hard rebuild replays the last
// rotation, snapped, after BUS_MIX (C10's order). Axis map (X, Y, Z)_ambix = (−z, −x, +y)_engine.
//
// B5 fills `stage` and `noteAmbisonicPlay` and flips `wideInitParams` (`initParams.ts`; the wide rings carry ambisonic streams).
// D3 owns the listener's velocity (`ListenerFrame.vel*`, `AudioListener.setVelocity`). K4 (the skeleton): LISTENER is
// never sent, so the replay has nothing to restore.
import { ASAP, LISTENER_FIXED_END, LISTENER_FLAGS_SNAP, writeListener } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";
import type { ListenerFrame } from "./spatial";

/** @internal C4: LISTENER is re-sent when the rotation moves more than this, radians. */
export const LISTENER_ROTATION_THRESHOLD = 0.001;

/** @internal LISTENER staging (constructed by the core backend). */
export class ListenerStage {
  /** True once a LISTENER went to this core (the replay restores it). */
  sent = false;
  /** The rotation last sent (world → listener, unit quaternion). */
  qx = 0;
  qy = 0;
  qz = 0;
  qw = 1;

  constructor(private readonly writer: Pick<CommandWriter, "listener">) {}

  /**
   * The frame's LISTENER (B5): from `frame`'s pose, when the rotation moved past the threshold, on `frame.cut` (snap),
   * or when an ambisonic play asked for it; over `rampFrames`. K4: nothing.
   */
  stage(frame: ListenerFrame, rampFrames: number): void {
    void frame;
    void rampFrames;
    void this.writer;
  }

  /** An ambisonic voice is about to play: the next `stage` sends LISTENER even if the rotation hasn't moved (C4). */
  noteAmbisonicPlay(): void {}

  /** Records what `stage` sent (B5 calls it with each LISTENER). */
  protected noteSent(qx: number, qy: number, qz: number, qw: number): void {
    this.sent = true;
    this.qx = qx;
    this.qy = qy;
    this.qz = qz;
    this.qw = qw;
  }

  /** A hard rebuild: the last rotation, snapped, after BUS_MIX and MASTER (C10). Nothing if none was ever sent. */
  replay(b: ReplayBuilder): void {
    if (!this.sent) return;
    const { qx, qy, qz, qw } = this;
    b.record(LISTENER_FIXED_END, (view, off) => writeListener(view, off, { voiceId: 0, frameOffset: ASAP, qx, qy, qz, qw, rampFrames: 0, flags: LISTENER_FLAGS_SNAP }));
  }
}
