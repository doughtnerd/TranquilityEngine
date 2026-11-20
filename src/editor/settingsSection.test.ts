import { describe, expect, it } from "vitest";
import { settingsSection } from "./settingsSection";
import type { SettingsDraft } from "./projectSettingsModel";

// A made-up key with a lenient parser: `size` must be a positive number (default 4), `deep.on` a boolean (default false).
interface Toy {
  size: number;
  deep: { on: boolean; name?: string };
}
const parse = (written: unknown) => {
  const w = (typeof written === "object" && written !== null ? written : {}) as Record<string, unknown>;
  const problems: string[] = [];
  let size = 4;
  if (w.size !== undefined) {
    if (typeof w.size === "number" && w.size > 0) size = w.size;
    else problems.push("toy.size must be a positive number.");
  }
  const deep = (w.deep ?? {}) as Record<string, unknown>;
  return { settings: { size, deep: { on: deep.on === true } } as Toy, problems };
};

describe("a settings section handle", () => {
  const toy = settingsSection<Toy>({ key: "toy", parse });

  it("reads the defaults when the key is absent, and a project's settings as well as a draft", () => {
    expect(toy.read({})).toEqual({ size: 4, deep: { on: false } });
    expect(toy.read(undefined)).toEqual({ size: 4, deep: { on: false } });
    expect(toy.read({ toy: { size: 9 } })).toEqual({ size: 9, deep: { on: false } });
  });

  it("sets a value by dotted path in the parsed section and writes the whole section back", () => {
    const d = toy.set({ name: "x" }, "deep.on", true);
    expect(d).toEqual({ name: "x", toy: { size: 4, deep: { on: true } } });
  });

  it("writes a rejected value as given, so it shows as a problem under the key until fixed", () => {
    const d = toy.set({}, "size", -1);
    expect(toy.problems(d)).toEqual([{ field: "toy", message: "toy.size must be a positive number." }]);
    expect(toy.read(d).size).toBe(4);
    expect(toy.problems(toy.set(d, "size", 2))).toEqual([]);
  });

  it("resets by removing the key", () => {
    const d: SettingsDraft = { name: "x", toy: { size: 2 } };
    expect(toy.reset(d)).toEqual({ name: "x", toy: undefined });
    expect(toy.read(toy.reset(d)).size).toBe(4);
  });

  it("writes through the spec's own writer when it has one", () => {
    const pruned = settingsSection<Toy>({ key: "toy", parse, write: (d, s) => ({ ...d, toy: { size: s.size } }) });
    expect(pruned.set({}, "deep.on", true)).toEqual({ toy: { size: 4 } });
    expect(pruned.write({}, { size: 3, deep: { on: true } })).toEqual({ toy: { size: 3 } });
  });

  describe('with "written" edits', () => {
    const sparse = settingsSection<Toy>({ key: "toy", parse, edits: "written", problems: (d) => (d.toy === null ? [{ field: "toy.size", message: "no" }] : []) });

    it("changes only the value at the path, so values never set keep following the defaults", () => {
      expect(sparse.set({}, "deep.on", true)).toEqual({ toy: { deep: { on: true } } });
      expect(sparse.set({ toy: { size: 2 } }, "deep.name", "a")).toEqual({ toy: { size: 2, deep: { name: "a" } } });
    });

    it("removes a value set to undefined, and objects and the section that leaves empty", () => {
      expect(sparse.set({ toy: { size: 2, deep: { on: true } } }, "deep.on", undefined)).toEqual({ toy: { size: 2 } });
      expect(sparse.set({ toy: { size: 2 } }, "size", undefined)).toEqual({ toy: undefined });
    });

    it("uses the spec's problems in place of the parse's", () => {
      expect(sparse.problems({ toy: null })).toEqual([{ field: "toy.size", message: "no" }]);
      expect(sparse.problems({ toy: { size: -1 } })).toEqual([]);
    });
  });
});
