// ADR 0158 E3.5c: AudioSource with an event asset, Audio.debug().events rows, voices[].event, lateStarts.
import { describe, it } from "vitest";
import { eventKit } from "./eventTestKit";

const kit = eventKit();
void kit;

describe("AudioSource with an event asset", () => {
  it.skip("plays the event as an instance that follows the node", () => {});
  it.skip("setParameter, getParameter and release reach the instance", () => {});
  it.skip("volume is applied as the instance's fade", () => {});
  it.skip("pitch changes reach the playing instance live", () => {});
});
describe("Audio.debug()", () => {
  it.skip("events rows carry id, asset, world, voices, parameters", () => {});
  it.skip("voices[].event names the instance id (null for plain clips)", () => {});
  it.skip("lateStarts counts per instance", () => {});
});
