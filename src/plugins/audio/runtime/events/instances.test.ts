// ADR 0158 E3.5b: event instances (limits, cooldown, groups, release, stop).
import { describe, it } from "vitest";
import { eventKit } from "./eventTestKit";

const kit = eventKit();
void kit;

describe("limit", () => {
  it.skip("steal oldest stops the oldest instance when the limit is reached", () => {});
  it.skip("steal quietest stops the quietest instance", () => {});
  it.skip("steal none refuses the new instance (inert handle)", () => {});
});
describe("cooldown", () => {
  it.skip("a play sooner than cooldown seconds after the last is refused; later is allowed", () => {});
});
describe("groups", () => {
  it.skip("1,024 live instances exhaust the group ids: extra ones play but warn once and get no local parameters", () => {});
  it.skip("a retired instance's group is reused", () => {});
});
describe("release and stop", () => {
  it.skip("release twice is a no-op the second time", () => {});
  it.skip("release on an event with no sustain is a no-op", () => {});
  it.skip("stop(fade) fades every voice of the instance", () => {});
});
