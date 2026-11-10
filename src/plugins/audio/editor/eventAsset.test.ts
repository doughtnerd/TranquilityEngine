import { describe, it } from "vitest";

// L6.2b fills these.
describe("audioEventFormat", () => {
  it.skip("parses a valid event with no problems and formats it back to the same value", () => {});
  it.skip("reports parse problems as { message } and never throws, for undefined and for junk", () => {});
});

describe("eventClipPaths", () => {
  it.skip("lists clips at every depth, once each, in tree order", () => {});
  it.skip("includes the start, loop and end slots of a sustain node", () => {});
  it.skip("leaves out empty paths", () => {});
});

describe("renameEventClips", () => {
  it.skip("rewrites every matching clip, including nested and sustain slots, without touching others", () => {});
  it.skip("does not modify its input", () => {});
  it.skip("returns an equal event when nothing matches", () => {});
});

describe("audioEventReferences", () => {
  it.skip("reads the clip paths from file text and nothing from invalid JSON", () => {});
});
