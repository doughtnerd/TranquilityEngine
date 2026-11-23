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
  @field(PlainObject, { animatable: ["targetPosition", "pose.position"] }) spring: Record<string, unknown> = {};
  @field(PlainObject, { animatable: [] }) emptyList: Record<string, unknown> = {};
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

describe("isFieldAnimatable sub-paths (D86)", () => {
  it("opens the listed paths of a plain object field", () => {
    expect(isFieldAnimatable(Sample, "spring.targetPosition")).toBe(true);
  });

  it("keeps the object itself and unlisted paths closed", () => {
    expect(isFieldAnimatable(Sample, "spring")).toBe(false);
    expect(isFieldAnimatable(Sample, "spring.stiffness")).toBe(false);
    expect(isFieldAnimatable(Sample, "emptyList.anything")).toBe(false);
  });

  it("matches a dotted entry exactly: an entry doesn't open the keys above or below it", () => {
    expect(isFieldAnimatable(Sample, "spring.pose.position")).toBe(true);
    expect(isFieldAnimatable(Sample, "spring.pose")).toBe(false);
    expect(isFieldAnimatable(Sample, "spring.pose.position.x")).toBe(false);
  });

  it("is false for a path into a field with no list (boolean, default or unknown)", () => {
    expect(isFieldAnimatable(Sample, "n.x")).toBe(false);
    expect(isFieldAnimatable(Sample, "blob.x")).toBe(false); // animatable: true is the whole field, not a path
    expect(isFieldAnimatable(Sample, "data.x")).toBe(false);
    expect(isFieldAnimatable(Sample, "missing.x")).toBe(false);
  });

  it("is inherited by subclasses", () => {
    expect(isFieldAnimatable(Child, "spring.targetPosition")).toBe(true);
  });
});
