// api-and-models §8, "Loopback" row: the real wasm with a fake HostClock, through `createLoopbackHost` (testing.ts).
// A1.7-L3 fills the cases. Those that need A1.4's `coreBackend` stay `it.skip`/`it.todo` until it lands.
import { describe, it } from "vitest";

describe("loopback host: raw BATCH records (runs now)", () => {
  it.todo("a Play record makes a voice play: the render is non-silent and the STATUS block counts the voice");
  it.todo("a voice that reaches the end of its clip appears in STATUS clipEvents (ended) within 6 quanta");
  it.todo("status buffers return at once: 10,000 quanta, none skipped, the STATUS pool back at 8");
  it.todo("no starvation with frames stopped: an idle host keeps STATUS flowing every 48 quanta");
  it.todo("no starvation at 20 Hz frames: a batch every 50 ms of fake time keeps the 6-quantum cadence");
  it.todo("a hidden page (clock.setRunning(false) for the context, no batches) still receives STATUS");
});

describe("loopback host: needs A1.4's coreBackend (skipped until it lands)", () => {
  it.todo("an AudioSource plays a generated WAV, and its end reaches playing = false");
  it.todo("virtual voices promote when a mixed slot frees");
  it.todo("REPLAY restores voices after a rebuild");
  it.todo("a seek epoch drops the old stream chunks");
});
