// The status reader (ADR 0157; api-and-models §4.3; ADR 0177): decodes a STATUS message into one preallocated
// `StatusBlock`, so the main thread allocates nothing per block (#66). The layout, the structural checks and the
// zero-allocation decode are the generated `StatusBlockReader` (`wire.generated.ts`, from the schema in
// `native/audio/crates/audio-wire`); a new header field or section reaches the block by name with no edit here. This
// file holds only what the schema can't say: the M5 count-sum rule (ADR 0171 §4.3, Wa2). The block it returns is the
// reader's own and is overwritten by the next `read`: consumers (the mirror, in `onmessage`) use it before returning.
import {
  ErrorCode,
  LOUD_FLAG_NEW_BLOCKS_MASK,
  STATUS_LOUD_BUSES_ITEM_AT,
  STATUS_LOUD_BUSES_ITEM_FIXED_END,
  STATUS_SECTION,
  StatusBlockReader,
  WireError,
} from "../wire.generated";

export class StatusReader extends StatusBlockReader {
  /**
   * ADR 0171 §4.3 (Wa2): the `loudBuses` new-block counts (`flags & 0x3F`) add up to `loudEnergyCount`, else `MALFORMED`
   * "STATUS: loudEnergies count sum" (the energies are bus-major, so a disagreement would mis-assign them). Runs after
   * the generated structural checks and before the block is written; reads the view, allocates nothing.
   */
  protected override check(view: DataView, _limit: number): void {
    const buses = this.sectionCount[STATUS_SECTION.loudBuses]!;
    let at = this.sectionAt[STATUS_SECTION.loudBuses]! + STATUS_LOUD_BUSES_ITEM_AT.flags;
    let sum = 0;
    for (let i = 0; i < buses; i++, at += STATUS_LOUD_BUSES_ITEM_FIXED_END) sum += view.getUint16(at, true) & LOUD_FLAG_NEW_BLOCKS_MASK;
    if (sum !== this.sectionCount[STATUS_SECTION.loudEnergies]!) throw new WireError(ErrorCode.MALFORMED, "STATUS: loudEnergies count sum");
  }
}
