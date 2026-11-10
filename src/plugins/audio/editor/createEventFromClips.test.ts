import { describe, it } from "vitest";

// L6.2a fills these.
describe("createEventFromClips", () => {
  it.skip("makes a random root with one clip child per path, in order", () => {});
  it.skip("drops duplicate paths", () => {});
  it.skip("sets avoidRepeat 1 for two or more clips, 0 for one or none", () => {});
  it.skip("carries the event defaults (limit 4 oldest, cooldown 0.05) and a full node base", () => {});
  it.skip("round-trips through formatAudioEvent and parseAudioEvent with no problems", () => {});
  it.skip("names the event after what the clips share, minus trailing digits and separators", () => {});
  it.skip("names a single clip after itself, without folder or extension", () => {});
  it.skip("falls back to New Event when nothing is shared or there are no clips", () => {});
});
