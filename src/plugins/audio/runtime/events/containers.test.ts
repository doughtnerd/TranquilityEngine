// ADR 0158 E3.5a: containers on the fake backend (random, sequence, switch, blend, layer, sustain, continuous).
import { describe, it } from "vitest";
import { eventKit } from "./eventTestKit";

const kit = eventKit();
void kit;

describe("random", () => {
  it.skip("weights bias the picks (seed 7)", () => {});
  it.skip("avoidRepeat n skips the last n picks", () => {});
});
describe("sequence (step)", () => {
  it.skip("advances one child per play and wraps", () => {});
  it.skip("reset seconds idle returns to the first child", () => {});
});
describe("switch", () => {
  it.skip("onChange keep leaves the playing child and uses the new value next play", () => {});
  it.skip("onChange restart stops the child and starts the new one", () => {});
  it.skip("onChange crossfade fades the old child out and the new one in", () => {});
  it.skip("falls back to default for an unmatched value", () => {});
});
describe("blend", () => {
  it.skip("plays every child, each with an equal-power weight from its range and edges", () => {});
  it.skip("fade width sets the edge ramp in parameter units; out-of-range children stay virtual (playing, silent)", () => {});
});
describe("layer", () => {
  it.skip("plays every child together", () => {});
});
describe("sustain container", () => {
  it.skip("start then loop play back to back (loop scheduled with `at`)", () => {});
  it.skip("release now: end plays with a crossfade of `fade` seconds", () => {});
  it.skip("release loopEnd: end starts at the end of the current loop pass", () => {});
});
describe("continuous", () => {
  it.skip("random continuous with known lengths schedules the next clip with `at`, counting no late start", () => {});
  it.skip("sequence continuous with known lengths plays the children back to back and loops", () => {});
  it.skip("unknown lengths: the next clip starts on the previous one's end (polled) and counts a late start", () => {});
});
