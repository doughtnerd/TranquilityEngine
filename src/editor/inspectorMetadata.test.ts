// ADR 0131: what the Inspector shows for a field comes from the field's declaration, not from
// matching type and field names. These checks replace "open the Inspector and look".
import { describe, expect, it } from "vitest";
import "../engine";
import { AssetRef, behavior, field, getComponentClass, getFields, isListType, listComponentIds, type FieldInfo } from "../engine/core/registry";
import { GameBehavior } from "../engine";
import type { FieldValue } from "../engine/editor";
import { assetKindsOf, assetListId, isHiddenField } from "./assetFieldKinds";
import { itemField } from "./fieldValues";

@behavior("test.inspectorMetadata.Jukebox")
class Jukebox extends GameBehavior {
  @field(AssetRef, { kind: "audio" }) track = "";
  @field(AssetRef) anything = "";
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
    ["engine.AudioSource", "clip", ["audio"]],
    ["engine.Tilemap", "tileset", ["tileset"]],
    ["engine.NavChunk", "bake", ["navbake"]],
  ])("%s.%s offers %j", (type, name, kinds) => {
    expect(kindsOf(type, name)).toEqual(kinds);
  });

  it("a material list's items offer materials", () => {
    const list = declared("engine.MeshRenderer", "materials");
    expect(assetListId(assetKindsOf(itemField(list, 0, "")))).toBe("asset-list-material");
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
  it("a declared kind gets the filtered list; an undeclared one every file", () => {
    expect(getComponentClass("test.inspectorMetadata.Jukebox")).toBe(Jukebox);
    expect(assetListId(kindsOf("test.inspectorMetadata.Jukebox", "track"))).toBe("asset-list-audio");
    expect(assetListId(kindsOf("test.inspectorMetadata.Jukebox", "anything"))).toBe("asset-list-all");
  });
});
