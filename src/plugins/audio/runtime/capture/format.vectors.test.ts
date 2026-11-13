// ADR 0171/0172 (Rc1, leaf L-Rc1c; api-and-models §5.3, §5.4): golden byte vectors per record type, in
// `capture/__fixtures__/records.json` (hex of head + payload, and the decoded fields). Each vector decodes to its fields
// and encodes back to its bytes; a whole-file vector (`__fixtures__/sample.mycap`, stored, with INDEX) opens and
// round-trips. L-Rc1c: write the fixtures, fill each skipped case and un-skip it.
import { describe, it } from "vitest";

describe("capture record vectors (L-Rc1c)", () => {
  it.skip("L-Rc1c: EPOCH vector (every reason 0..6) decodes and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: GAP vector (every reason 1..5) decodes and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: STATUS vector (a real wire block) frames, checks and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: EVENT vectors (one per kind 1..19, f32 present exactly for 1, 11, 14, 18) decode and re-encode byte-equal", () => {});
  it.skip("L-Rc1c: MARKER vectors (empty, ASCII, multi-byte UTF-8 at 120 B) decode and re-encode byte-equal", () => {});
  it.skip("L-Rc1c: NAMES vectors (every table 0..5, a 256 B name) decode and re-encode byte-equal", () => {});
  it.skip("L-Rc1c: MIXOP vector (from encodeMixOp of a real op) decodes and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: INDEX vector (0 and 2 entries) decodes and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: a deferred record vector (stamp first in the payload) decodes and re-encodes byte-equal", () => {});
  it.skip("L-Rc1c: the whole-file vector opens, every record round-trips, and assembleCapture rebuilds it byte-equal", () => {});
});
