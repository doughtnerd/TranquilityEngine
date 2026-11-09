import { describe, it } from "vitest";

// A0.3 core: the shell's logic in Node with the real myco_audio.wasm (architecture §4.6), wired to the main
// side's CoreLink through a synchronous fake port, under a fake clock.
describe("coreDriver with the real wasm", () => {
  it.todo("instantiates on 64 initial pages and lands init on the same addresses each time");
  it.todo("refuses a schema hash or ABI major mismatch with CoreLoadError");
  it.todo("posts a STATUS every 6 quanta that readStatus reads, ready flag and ABI version in the first block");
  it.todo("echoes a TIME_PING's pingSeq and frame in the next STATUS");
  it.todo("RECYCLE returns buffers to the pool: 8 buffers circulate for 10,000 quanta with none skipped");
  it.todo("without RECYCLE the pool runs dry after 8 posts and later posts are skipped");
  it.todo("frames stopped: no batches, STATUS slows to every 48 quanta after 250 ms and keeps flowing");
  it.todo("a batch brings the 6-quantum cadence back");
  it.todo("shell fields (dateMs, ping, underruns, traps) land where readStatus reads them");
  it.todo("a trap gives silence, counts, flags and posts a trap event");
  it.todo("the debug tone is a sine on both channels; off is silence");
});

describe("UnderrunProbe", () => {
  it.todo("steady rendering counts no underrun");
  it.todo("a 50 ms stall after warm-up counts one underrun of about 50 ms");
  it.todo("a gap over 500 ms or a clock going back re-anchors without counting");
  it.todo("stalls during the 1 s warm-up don't count");
});
