import { describe, it } from "vitest";

describe("encodedCache (A1.3a-L2)", () => {
  it.todo("set then get returns the same buffer; has and size agree");
  it.todo("refuses an entry that would pass the cap and stores nothing");
  it.todo("an entry exactly filling the cap is accepted");
  it.todo("replacing a path counts the new size against the cap, not both");
  it.todo("delete frees its bytes and reports whether it existed");
  it.todo("clear empties the cache");
  it.todo("a default cache caps at 32 MB");
});
