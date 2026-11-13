// ADR 0171 amended by 0172 (M5, contract K0; plan seam): presence ducking in the core (ADR 0172 §1.1). The core backend
// calls these hooks when the bus tree is configured and when a voice starts or stops; Dp1 (W4) fills them: `BUS_DUCK`
// with the presence rules at configure, and `BUS_PRESENCE` (a slot mask, bit b while slot b has a voice, virtual and
// locked included) stamped at the frame of the voice start or explicit stop. Until then every hook is a no-op and main
// keeps computing presence ducks (`mixer.ts`), as the Babylon fallback always does.
import type { Mixer } from "../../../../engine/audio/mixer";
import type { DuckingRule } from "../../../../engine/audio/settings";

export class Presence {
  /** Dp1: the bus tree was (re)configured with `mixer`'s settings: send the rules and the presence mask. */
  configured(_mixer: Mixer, _busLive: ArrayLike<number>): void {}

  /** Dp1: a voice started on bus index `bus` (its count already raised); `frame` is its start frame, 0 for asap. */
  voiceStarted(_bus: number, _frame: number): void {}

  /** Dp1: a voice on bus index `bus` stopped or ended (its count already lowered); `frame` 0 for asap or a natural end. */
  voiceStopped(_bus: number, _frame: number): void {}

  /** Dp1 (Sc1 adds level rules): `BUS_DUCK`, every rule, replace-all, asap (§4.2). */
  writeDucking(_rules: readonly DuckingRule[]): void {
    throw new Error("Dp1");
  }
}
