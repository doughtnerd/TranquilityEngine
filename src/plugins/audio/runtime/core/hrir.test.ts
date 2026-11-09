import { describe, it } from "vitest";

describe("hrir loader", () => {
  it.todo("fetches lazily on the first ensure() and only once");
  it.todo("resamples the blob to the context rate and scales the ear delays");
  it.todo("loads under the reserved clip id with format 2 and is not counted in clipMemoryMB");
  it.todo("is ready only after clip event 4; re-sent on rebuild");
});
