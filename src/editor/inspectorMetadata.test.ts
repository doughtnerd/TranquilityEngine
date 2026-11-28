// ADR 0131: what the Inspector shows for a field comes from the field's declaration, not from
// matching type and field names. These checks replace "open the Inspector and look".
import { describe, expect, it } from "vitest";
import "../engine";
import { AssetRef, behavior, field, getComponentClass, getFields, isListType, listComponentIds, type FieldInfo } from "../engine/core/registry";
import { GameBehavior } from "../engine";
import type { ComponentInfo, FieldValue } from "../engine/editor";
import { assetKindsOf, isHiddenField } from "./assetFieldKinds";
import { itemField } from "./fieldValues";
import { inspectorFields } from "./fieldVisibility";

@behavior("test.inspectorMetadata.Jukebox")
class Jukebox extends GameBehavior {
  @field(AssetRef, { kind: "audio" }) track = "";
  @field(AssetRef) anything = "";
}

@behavior("test.inspectorMetadata.Lamp")
class Lamp extends GameBehavior {
  @field(String, { choices: ["point", "spot"] }) shape = "point";
  @field(Number, { shownWhen: (v) => v.shape === "spot" }) angle = 30;
  @field(Number, { shownWhen: () => { throw new Error("broken"); } }) broken = 0;
  @field(Number, { hidden: true, shownWhen: () => true }) owned = 0;
}

const asValue = (f: FieldInfo): FieldValue => ({ name: f.name, type: f.type, value: undefined, options: f.options });

function declared(type: string, name: string): FieldValue {
  const cls = getComponentClass(type);
  if (!cls) throw new Error(`${type} isn't registered`);
  const f = getFields(cls).find((x) => x.name === name);
  if (!f) throw new Error(`${type}.${name} isn't declared`);
  return asValue(f);
}

const kindsOf = (type: string, name: string) => assetKindsOf(declared(type, name));

describe("engine asset fields", () => {
  it("every engine AssetRef field declares a kind", () => {
    const missing: string[] = [];
    for (const id of listComponentIds().filter((i) => i.startsWith("engine."))) {
      for (const f of getFields(getComponentClass(id)!)) {
        const item = isListType(f.type) ? f.type[0] : f.type;
        if (item === AssetRef && f.options?.kind === undefined) missing.push(`${id}.${f.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each([
    ["engine.MeshRenderer", "mesh", ["mesh"]],
    ["engine.MeshRenderer", "material", ["material"]],
    ["engine.MeshRenderer", "materials", ["material"]],
    ["engine.MeshCollider", "mesh", ["mesh"]],
    ["engine.Camera", "targetTexture", ["rendertexture"]],
    ["engine.ParticleSystem", "effect", ["particles"]],
    ["engine.NavGroup", "formationAsset", ["formation"]],
    ["engine.PostProcessing", "lut", ["lut"]],
    ["engine.ReflectionProbe", "bakedMap", ["envmap"]],
    ["engine.Environment", "map", ["environment"]],
    ["engine.SpriteRenderer", "sprite", ["sprite"]],
    ["engine.AudioSource", "clip", ["audio", "playlist"]], // ADR 0343: a clip or a playlist
    ["engine.Tilemap", "tileset", ["tileset"]],
    ["engine.NavChunk", "bake", ["navbake"]],
  ])("%s.%s offers %j", (type, name, kinds) => {
    expect(kindsOf(type, name)).toEqual(kinds);
  });

  it("a material list's items offer materials", () => {
    const list = declared("engine.MeshRenderer", "materials");
    expect(assetKindsOf(itemField(list, 0, ""))).toEqual(["material"]);
  });

  it.each([
    ["engine.ParticleSystem", "embeddedEffect"],
    ["engine.ParticleSystem", "overrides"],
    ["engine.Tilemap", "layers"],
  ])("%s.%s is hidden (another editor owns it)", (type, name) => {
    expect(isHiddenField(declared(type, name))).toBe(true);
  });

  it("ordinary fields aren't hidden", () => {
    expect(isHiddenField(declared("engine.ParticleSystem", "effect"))).toBe(false);
  });
});

describe("script component asset fields", () => {
  it("a declared kind narrows the files; an undeclared one takes every file", () => {
    expect(getComponentClass("test.inspectorMetadata.Jukebox")).toBe(Jukebox);
    expect(kindsOf("test.inspectorMetadata.Jukebox", "track")).toEqual(["audio"]);
    expect(kindsOf("test.inspectorMetadata.Jukebox", "anything")).toEqual([]);
  });
});

/** A component as the Inspector lists it: its declared fields with these values (defaults for the rest). */
function listed(type: string, values: Record<string, unknown>): ComponentInfo {
  const cls = getComponentClass(type)!;
  const defaults = new (cls as unknown as new () => Record<string, unknown>)();
  const fields = getFields(cls).map((f): FieldValue => ({ ...asValue(f), value: f.name in values ? values[f.name] : defaults[f.name] }));
  return { kind: "behavior", type, index: 0, component: null, enabled: true, fields };
}
const shown = (type: string, ...values: Record<string, unknown>[]) => inspectorFields(values.map((v) => listed(type, v))).map((f) => f.name);

describe("conditional fields (shownWhen)", () => {
  it("shows a field only while its condition holds on the component's values; hidden wins; a throwing condition shows it", () => {
    expect(shown("test.inspectorMetadata.Lamp", {})).toEqual(["shape", "broken"]);
    expect(shown("test.inspectorMetadata.Lamp", { shape: "spot" })).toEqual(["shape", "angle", "broken"]);
  });

  it("with several nodes selected, shows the field if any of them meets the condition", () => {
    expect(shown("test.inspectorMetadata.Lamp", { shape: "point" }, { shape: "spot" })).toContain("angle");
    expect(shown("test.inspectorMetadata.Lamp", { shape: "point" }, { shape: "point" })).not.toContain("angle");
  });

  it.each([
    ["square", []],
    ["isometric", []],
    ["staggered", ["staggerAxis", "staggerIndex"]],
    ["hexagonal", ["staggerAxis", "staggerIndex", "hexSide"]],
  ])("a %s Tilemap shows the grid fields %j", (gridShape, extra) => {
    const fields = shown("engine.Tilemap", { gridShape });
    expect(fields.filter((f) => ["staggerAxis", "staggerIndex", "hexSide"].includes(f))).toEqual(extra);
    expect(fields).toContain("gridShape");
    expect(fields).not.toContain("layers");
  });
});
