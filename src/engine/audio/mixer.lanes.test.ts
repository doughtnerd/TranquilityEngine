// Mx1 (ADR 0172 §1.3; design api-and-models §1.1, §1.4, §3.1; architecture §4.5): the mixer's main-side lanes.
// Acceptance: "fade, snapshot and presence-duck curves equal today's at the heard clock to the ramp's exactness;
// `configure` still clears script state". Timing is on the heard clock (frames / sample rate), never wall-clock.
//
// L-Mx1b fills every `it.skip` below. "Today's" curves come from `TodayMixer`, a frozen copy of the pre-M5 mixer's
// fade, snapshot and ducking maths (`git show 770bcf1:src/engine/audio/mixer.ts`, lines 155-219 and 258-268),
// written into this file (the leaf owns only this file).
import { describe, it } from "vitest";

describe("Mixer lanes on the heard clock (Mx1)", () => {
  describe("fadeTo: one ramp on the runtime lane", () => {
    it.skip("a fade read every frame equals today's per-frame fade (authored 1), frame by frame, to 1e-12", () => {});
    it.skip("with authored volume 0.8, fadeTo(0.5, 1) plays 0.4 at the end and authoredVolume still reads 0.8", () => {});
    it.skip("a registered heard clock drives the fade: reading at frame f gives from + (to - from) * (f / sr - start) / seconds", () => {});
    it.skip("fadeTo(v, 0) reads v at once and writes one ramp record of 0 seconds (the writer applies BUS_MIN_RAMP_MS)", () => {});
    it.skip("a retarget mid-fade starts from the current value (no jump)", () => {});
    it.skip("the volume setter cancels a running fade", () => {});
    it.skip("values clamp to 0..2; a non-finite volume reads 0", () => {});
    it.skip("onChange fires every frame the ramp moves, once on the frame it ends, then stops", () => {});
  });

  describe("snapshots: ramps on the snapshot lane", () => {
    it.skip("snapshot(name, s) gain and low-pass curves equal today's frame by frame, to 1e-9", () => {});
    it.skip("a snapshot interrupted mid-transition by clearSnapshot equals today's curve", () => {});
    it.skip("snapshot(name, 0) jumps at once", () => {});
  });

  describe("presence ducking (main-side until Dp1)", () => {
    it.skip("duck curve during attack and release equals today's frame by frame; duckGain reads it", () => {});
    it.skip("two rules on one target head for the lowest amount", () => {});
    it.skip("a rule with mode 'level' is not computed on main", () => {});
  });

  describe("composition", () => {
    it.skip("resolve().gain = authored x runtime x snapshot x dip x duck x automation, and equals today's for today's inputs", () => {});
    it.skip("authored mute, script mute and monitor mute each give 0; script mute starts false even when authored mute is true", () => {});
    it.skip("monitor solo gates like script solo (the solo rule over the tree)", () => {});
    it.skip("laneGain reports each lane", () => {});
  });

  describe("configure", () => {
    it.skip("clears script volume, fades, mute, solo, the snapshot and monitor controls; authored values come from the settings", () => {});
  });

  describe("loudness and apply", () => {
    it.skip("Bus.loudness is the same object every read, inert before a source registers, and forwards once one does", () => {});
    it.skip("a missing bus's loudness is EMPTY_BUS_LOUDNESS; controls are no-ops", () => {});
    it.skip("apply delegates to the registered target's applyOp and keeps script state", () => {});
  });
});
