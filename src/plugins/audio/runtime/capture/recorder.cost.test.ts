// ADR 0171 amended by 0172 (M5a, Rc2; architecture §7.3): the recorder's main-thread cost on a synthetic STATUS stream
// at 64 / 256 / 1,024 voices, reported in ms per second of audio. The ≤ 1 ms/s at 1,024 voices is a project tripwire: a
// miss is logged (and raised in the build log), never asserted on wall-clock time (ground rules: timing assertions use
// the audio clock). What it asserts is the audio clock: the stream covered the seconds it claims.
import { describe, expect, it } from "vitest";
import { createRecorder, type EpochContext } from "./recorder";
import { SAMPLE_RATE, keyframeCodecForTests, statusBytesWithVoices } from "./testSupport";

const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };
const SECONDS = 60;
const BLOCK = 768;
const TRIPWIRE_MS_PER_S = 1;

function measure(voices: number, handOff: boolean): number {
  const r = createRecorder({ preset: "default", codec: keyframeCodecForTests() });
  if (handOff) r.onSegmentSealed = () => {};
  const block = statusBytesWithVoices(0, voices);
  const data = block.slice().buffer as ArrayBuffer;
  const view = new DataView(data);
  const blocks = Math.floor((SECONDS * SAMPLE_RATE) / BLOCK);
  r.begin(0, CONTEXT);
  // Warm the JIT on the same path first.
  for (let k = 1; k <= 2000; k++) {
    view.setFloat64(16, k * BLOCK, true);
    r.tap(data, block.byteLength, view);
  }
  const base = 2000 * BLOCK;
  const t0 = performance.now();
  for (let k = 1; k <= blocks; k++) {
    view.setFloat64(16, base + k * BLOCK, true);
    r.tap(data, block.byteLength, view);
  }
  const ms = performance.now() - t0;
  expect(r.newestStatusFrame - base).toBe(blocks * BLOCK); // the audio clock covered the run
  return ms / ((blocks * BLOCK) / SAMPLE_RATE);
}

describe("recorder cost (§7.3)", () => {
  it("reports ms per second of audio at 64 / 256 / 1,024 voices (STATUS copy, keyframe path, eviction)", () => {
    const rows: string[] = [];
    for (const voices of [64, 256, 1024]) {
      const copy = measure(voices, false);
      const withHandOff = measure(voices, true);
      rows.push(`${voices} voices (${statusBytesWithVoices(0, voices).byteLength} B blocks): ${copy.toFixed(3)} ms/s; with the segment hand-off copy ${withHandOff.toFixed(3)} ms/s`);
      if (voices === 1024 && withHandOff > TRIPWIRE_MS_PER_S) {
        console.warn(`recorder cost tripwire: ${withHandOff.toFixed(3)} ms/s at 1,024 voices is past ${TRIPWIRE_MS_PER_S} ms/s (log and raise; don't trade)`);
      }
    }
    console.log(`recorder cost (container, est. ×8 on the floor):\n  ${rows.join("\n  ")}`);
  });
});
