// Avatar masks (`myco.mask@1`, ADR 0371) through their parse and write.
import { describe, expect, it } from "vitest";
import { emptyMask, formatMask, MASK_LIMITS, maskReferences, maskToJson, parseMask, type AvatarMask } from "./mask";

const mask = (): AvatarMask => ({
  format: "myco.mask@1",
  profile: "asset:rigs/humanoid.skelprofile.json",
  entries: [{ bone: "Spine2", weight: 1, recursive: true }, { role: "LeftUpperArm", weight: 0.5, recursive: false }, { bone: "Head", weight: 0, recursive: true }],
});

describe("avatar masks (myco.mask@1)", () => {
  it("round-trip, writing only what differs from the defaults", () => {
    const read = parseMask(JSON.parse(formatMask(mask())));
    expect(read).toEqual({ value: mask(), problems: [] });
    expect(maskToJson(mask()).entries).toEqual([{ bone: "Spine2" }, { role: "LeftUpperArm", weight: 0.5, recursive: false }, { bone: "Head", weight: 0 }]);
    expect(parseMask(maskToJson(emptyMask()))).toEqual({ value: emptyMask(), problems: [] });
  });

  it.each<[string, unknown, string]>([
    ["neither bone nor role", {}, "entries[0]: an entry names exactly one of bone or role; dropped."],
    ["both bone and role", { bone: "A", role: "B" }, "entries[0]: an entry names exactly one of bone or role; dropped."],
    ["not an object", 3, "entries[0]: an entry must be an object; dropped."],
  ])("drop a bad entry: %s", (_label, entry, problem) => {
    const read = parseMask({ format: "myco.mask@1", entries: [entry] });
    expect(read.problems).toEqual([problem]);
    expect(read.value.entries).toEqual([]);
  });

  it("drop a repeated bone and clamp a weight, one problem each", () => {
    const read = parseMask({ format: "myco.mask@1", entries: [{ bone: "A", weight: 2 }, { bone: "A" }] });
    expect(read.problems).toEqual(["entries[0].weight: 2 is outside 0..1; using 1.", 'entries[1]: bone "A" is already in the mask; dropped.']);
    expect(read.value.entries).toEqual([{ bone: "A", weight: 1, recursive: true }]);
  });

  it("hold the entry limit", () => {
    const entries = Array.from({ length: MASK_LIMITS.entries + 1 }, (_, i) => ({ bone: `b${i}` }));
    const read = parseMask({ format: "myco.mask@1", entries });
    expect(read.value.entries).toHaveLength(MASK_LIMITS.entries);
    expect(read.problems).toEqual([`entries: at most ${MASK_LIMITS.entries} entries; the rest are dropped.`]);
  });

  it("name their profile", () => {
    expect(maskReferences(mask())).toEqual(["rigs/humanoid.skelprofile.json"]);
    expect(maskReferences(emptyMask())).toEqual([]);
  });
});
