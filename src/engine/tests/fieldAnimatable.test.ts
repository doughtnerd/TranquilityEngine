// ADR 0371 (completing 0159): the `animatable` field option and its defaults by type.
import { describe, expect, it } from "vitest";
import { AssetRef, Color, Component, GameObject, PlainObject, Quaternion, Vector2, Vector3, component, field } from "..";
import { isFieldAnimatable } from "../core/registry";

enum Mode { Idle, Run }

@component("test.fieldAnimatable.Sample")
class Sample extends Component {
  @field(Number) n = 0;
  @field(Vector2) v2 = new Vector2();
  @field(Vector3) v3 = new Vector3();
  @field(Quaternion) q = new Quaternion();
  @field(Color) c = new Color();
  @field(Boolean) flag = false;
  @field(String, { choices: ["a", "b"] }) stringEnum = "a";
  @field(Number, { choices: Mode }) numberEnum = Mode.Idle;
  @field(String, { choices: (s) => s.physics.layers }) layer = "Default";
  @field(AssetRef, { kind: "texture" }) texture = "";
  @field(String) text = "";
  @field([Number]) numbers: number[] = [];
  @field([String], { choices: ["a", "b"] }) tags: string[] = [];
  @field([AssetRef]) assets: string[] = [];
  @field(PlainObject) data: Record<string, unknown> = {};
  @field(GameObject) target: GameObject | null = null;
  @field(Number, { animatable: false }) pinned = 0;
  @field(String, { animatable: true }) title = "";
  @field(PlainObject, { animatable: true }) blob: Record<string, unknown> = {};
  @field(Boolean, { animatable: false, description: "kept beside other options" }) locked = false;
}

@component("test.fieldAnimatable.Child")
class Child extends Sample {
  @field(Number) extra = 0;
  @field(Number, { animatable: false }) pinnedAgain = 0;
}

@component("test.fieldAnimatable.Redeclare")
class Redeclare extends Sample {
  @field(Number, { animatable: false }) n = 1;
}

describe("isFieldAnimatable defaults by type", () => {
  it.each(["n", "v2", "v3", "q", "c", "flag", "stringEnum", "numberEnum", "layer", "texture"])("%s is animatable", (name) => {
    expect(isFieldAnimatable(Sample, name)).toBe(true);
  });

  it.each(["text", "numbers", "tags", "assets", "data", "target"])("%s is not animatable", (name) => {
    expect(isFieldAnimatable(Sample, name)).toBe(false);
  });

  it("is false for a name the class does not declare", () => {
    expect(isFieldAnimatable(Sample, "missing")).toBe(false);
  });
});

describe("isFieldAnimatable explicit overrides", () => {
  it("false opts a default-true field out", () => {
    expect(isFieldAnimatable(Sample, "pinned")).toBe(false);
    expect(isFieldAnimatable(Sample, "locked")).toBe(false);
  });

  it("true opts a default-false field in", () => {
    expect(isFieldAnimatable(Sample, "title")).toBe(true);
    expect(isFieldAnimatable(Sample, "blob")).toBe(true);
  });
});

describe("isFieldAnimatable through subclasses", () => {
  it("inherits the parent's fields and overrides", () => {
    expect(isFieldAnimatable(Child, "n")).toBe(true);
    expect(isFieldAnimatable(Child, "pinned")).toBe(false);
    expect(isFieldAnimatable(Child, "title")).toBe(true);
    expect(isFieldAnimatable(Child, "text")).toBe(false);
  });

  it("covers the subclass's own fields without changing the parent", () => {
    expect(isFieldAnimatable(Child, "extra")).toBe(true);
    expect(isFieldAnimatable(Child, "pinnedAgain")).toBe(false);
    expect(isFieldAnimatable(Sample, "extra")).toBe(false);
  });

  it("lets a subclass's redeclaration win", () => {
    expect(isFieldAnimatable(Redeclare, "n")).toBe(false);
    expect(isFieldAnimatable(Sample, "n")).toBe(true);
  });
});
