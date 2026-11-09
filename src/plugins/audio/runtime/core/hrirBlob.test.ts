import { describe, it } from "vitest";

// Checks the committed myco_hrir.bin against the layout in audio-dsp's database.rs (what HrirDatabase::parse enforces).
describe("myco_hrir.bin", () => {
  it.todo("has the 10 x 24 x 256 @ 44100 header and exactly the documented byte length");
  it.todo("has finite non-negative ear delays");
  it.todo("has a peak below full scale and a leading edge near the 20-frame headroom");
});
