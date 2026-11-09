// A1.4 (lead): the status reader (api-and-models §4.3).
import { describe, it } from "vitest";

describe("StatusReader (§4.3)", () => {
  it.todo("reads every field and section the way readStatus does");
  it.todo("refuses what readStatus refuses (bad magic, version, truncation, overrun counts) with the same codes");
  it.todo("returns the same block object every call and a shorter second block leaves no stale section entries");
  it.todo("reading allocates nothing in steady state");
});
