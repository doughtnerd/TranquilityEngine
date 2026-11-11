// ADR 0166 M4 (Z4, leaf L-Z4b; api-and-models §4.1, §4.2): the shape word, `fadeZero` and the gate on the writer. Cases
// read the posted BATCH back with the generated readers (`readPlay`, `readFade`, `readStop`, `readSetParams`) like
// `commandWriterM3.test.ts`. Skipped until L-Z4b fills the stubs.
import { describe, it } from "vitest";

describe("CommandWriter, ADR 0166 records (L-Z4b)", () => {
  it.skip("play writes gate 0 without PlayArgs.gate, and the given gate with it", () => {});
  it.skip("playGated packs packGate(groupId, groupSize) into the PLAY gate (id 1023, size 64 and id 1, size 1 round-trip through gateGroupId and gateGroupSize) and is stamped like play", () => {});
  it.skip("PlayArgs.fadeZero sets bit 8 (PLAY_FLAGS_FADE_ZERO) and keeps every other flag bit", () => {});
  it.skip("fade (asap, linear) is a 28-byte FADE whose shape word reads 0, so a plain fade keeps today's behaviour", () => {});
  it.skip("fadeShaped writes a 28-byte FADE with packShape(law, startPhase) (law 2, phase 0.5 reads back as 2 and 32768), target, frames at the writer's rate and flags 0; stopAtEnd sets FADE_FLAGS_STOP_AT_END", () => {});
  it.skip("fadeShaped with atFrame sorts among stamped records and gets a frameOffset at flush; without atFrame it is asap", () => {});
  it.skip("stopShaped writes a 24-byte STOP with the shape word and the fade in frames; stop (plain) is 24 bytes with shape 0", () => {});
  it.skip("setParams with shape writes a 60-byte SET_PARAMS carrying the shape word, stamped when atFrame is given; without them the shape reads 0", () => {});
  it.skip("a gate group's records stay in one BATCH: with records of group 7 straddling the 64 KB limit, the whole group moves to the next batch and its absolute frame is kept", () => {});
  it.skip("staging capacity is checked at the new sizes (28, 60, 24 B), not the old (24, 56, 20): a full staging area drops a FADE that no longer fits", () => {});
});
