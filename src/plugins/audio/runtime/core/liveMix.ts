// ADR 0171 amended by 0172 (M5, contract K0; plan seam): the core backend's live-edit path (api-and-models §6.1–§6.2,
// architecture §4.7). `CoreBackend.applyOp` routes every op here. Ma1 (W5) fills the direct and smoothed classes
// (`BUS_RAMP` on the authored lane, `BUS_SLOT`, `BUS_DUCK`, `LOUD_CONFIG`, automation rebind, bed replan) and
// `flushNow`; structural ops go to `structuralDip.ts` (Ma2) and adds with no free slot to `deferredAdds.ts` (Ma3).
// Until then every op answers `restartRequired`: the edit is saved and applies at the next Play, so nothing can click.
import type { ApplyResult, MixOp, OpClass } from "../../../../engine/audio/mixOps";
import type { StructuralDip } from "./structuralDip";
import type { DeferredAdds } from "./deferredAdds";
import type { BusSlotWrite, LoudnessConfigWrite } from "../backend";

/** The answer of every op until Ma1 (the Mixer panel shows "Applies at the next Play: ..."). */
export const RESTART_REQUIRED = "live mixing isn't available yet";

/** What the live path needs of the core backend (Ma1 adds members as it fills the path). */
export interface LiveMixHost {
  readonly dip: StructuralDip;
  readonly deferred: DeferredAdds;
}

export class LiveMix {
  /** Live edits refused (`Audio.debug().mix.liveRefused`). */
  refused = 0;

  constructor(protected readonly host: LiveMixHost) {}

  /**
   * Ma1: apply one op to the running core. K0's stub answers `restartRequired` for every op, with `ok: false` (nothing
   * changed in the running mix) and `class: "none"` (`opClass` is Mo1's).
   */
  apply(_op: MixOp): ApplyResult {
    const cls: OpClass = "none";
    return { ok: false, class: cls, restartRequired: RESTART_REQUIRED };
  }

  /** Ma1: post the pending batch now (the fader's preview path, coalesced to one post per `FADER_COALESCE_MS`). */
  flushNow(): void {}

  /** Ma1 (Ma2 for structural records): one `BUS_SLOT` (§4.2, R7). */
  writeSlot(_w: BusSlotWrite): void {
    throw new Error("Ma1");
  }

  /** Ma1 (with Ld2/Ld4's meter list): `LOUD_CONFIG`, replace-all, asap (§4.2; a meter or target edit is a direct op, architecture §4.7). */
  writeLoudnessConfig(_c: LoudnessConfigWrite): void {
    throw new Error("Ma1");
  }
}
