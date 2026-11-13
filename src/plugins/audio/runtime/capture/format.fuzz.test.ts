// ADR 0171/0172 (Rc1, leaf L-Rc1a; api-and-models §10 capture row, §5.1, §5.3, §5.7): decode fuzz and bombs. Each
// case ends in a `CaptureError` with the code named, and no allocation the reader reports (`ReaderOptions.onAllocate`)
// passes the caps. Build inputs with `testSupport.ts` (`sampleCapture`, `sampleRecords`) and `format.ts`'s writers.
// L-Rc1a: fill each skipped case and un-skip it; add cases, never remove one.
import { describe, it } from "vitest";

describe("capture decode fuzz (L-Rc1a)", () => {
  it.skip("L-Rc1a: a corrupted value in every header field refuses with its code (§5.1 order: badMagic, newerFormat/olderFormat, wireMismatch, tooLarge, then badHeader/metaTooLarge/tooManyRecords)", () => {});
  it.skip("L-Rc1a: every single-byte flip of the 96 B header either opens identically or throws CaptureError (never another error)", () => {});
  it.skip("L-Rc1a: a corrupted byte in every record head field (type, flags, epoch, len, seq, frame) of every record type throws CaptureError or opens identically", () => {});
  it.skip("L-Rc1a: a corrupted enum or count in every record payload (EPOCH reason and rate, GAP reason and order, EVENT kind/reason/argc, MARKER n, NAMES table/n, MIXOP op/class/argc/origin, INDEX count) throws badValue or badLength", () => {});
  it.skip("L-Rc1a: a lying len (one short, one long, past the end) in every record type: badLength or truncatedRecord", () => {});
  it.skip("L-Rc1a: a count past its cap (recordCount past uncompressedBytes / 20, EVENT argc, INDEX keyframeCount, 65,537 names) refuses before allocating", () => {});
  it.skip("L-Rc1a: 4 GB declared (uncompressedBytes, recordBytes, len 0xffffffff, metaBytes 0xffffffff) refuses from the header with no allocation", () => {});
  it.skip("L-Rc1a: a deflate bomb (more than 64 MiB of output, and output past a small declared size) stops at uncompressedBytes + 1 (inflateOverrun)", () => {});
  it.skip("L-Rc1a: a 10 MB name (in META: metaTooLarge; in NAMES and MARKER: textTooLong or recordTooLarge)", () => {});
  it.skip("L-Rc1a: invalid UTF-8 in META, MARKER and NAMES: badUtf8", () => {});
  it.skip("L-Rc1a: an unknown required type (0x80..0xFF) is unknownRequired; an unknown type below 0x80 is skipped", () => {});
  it.skip("L-Rc1a: truncation at every byte boundary of a whole file throws CaptureError", () => {});
  it.skip("L-Rc1a: a seeded random fuzz (fixed seed, 2,000 mutations) throws only CaptureError and never allocates past the caps", () => {});
});
