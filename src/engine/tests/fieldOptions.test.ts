// ADR 0131: asset kind and Inspector visibility declared on fields.
import { describe, expect, it } from "vitest";
import { AssetRef, GameBehavior, PlainObject, behavior, field } from "..";
import { getFields } from "../core/registry";

@behavior("test.fieldOptions.Skin")
class Skin extends GameBehavior {
  @field(AssetRef, { kind: "material" }) material = "";
  @field([AssetRef], { kind: ["texture", "rendertexture"] }) layers: string[] = [];
  @field(PlainObject, { hidden: true }) cache: Record<string, unknown> = {};
}

describe("field options kind and hidden", () => {
  it("round-trip through the field declarations", () => {
    const byName = Object.fromEntries(getFields(Skin).map((f) => [f.name, f.options]));
    expect(byName.material).toEqual({ kind: "material" });
    expect(byName.layers).toEqual({ kind: ["texture", "rendertexture"] });
    expect(byName.cache).toEqual({ hidden: true });
  });

  it("refuse a kind on a field that doesn't hold assets", () => {
    expect(() => field(String, { kind: "material" })).toThrow(/AssetRef/);
    expect(() => field([Number], { kind: "audio" })).toThrow(/AssetRef/);
  });
});
