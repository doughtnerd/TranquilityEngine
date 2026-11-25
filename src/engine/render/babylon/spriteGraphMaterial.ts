/**
 * A 2D draw's material from a sprite shader graph (ADR 0415): the graph's material (`graphMaterial.ts`) set up as a
 * layered quad (no depth write or test, alpha blended, both faces, ADR 0186), with the draw's own texture as the graph's
 * Sprite Texture and that texture's secondary textures (ADR 0414) as its Secondary Textures, and the 2D light plugin:
 * a Sprite Lit graph lit through its layer batch (with the graph's normal and mask when connected), a Sprite Custom Lit
 * graph given its light functions, a Sprite Unlit graph none. One material per draw setup; the caller disposes it.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Assets } from "../../scene/Assets";
import type { GraphValue } from "../../scene/shaderGraph";
import type { BabylonGraphMaterial } from "./graphMaterial";
import { lightLayeredQuads } from "./layeredQuads";
import type { LitQuadSetup } from "./lights2DMaterial";
import type { SpriteGraph } from "./materialLibrary";

/** What builds the graph's material (the material library's `spriteGraphMaterial`). */
export type SpriteGraphFactory = (name: string, graph: SpriteGraph, overrides: Record<string, GraphValue>) => BabylonGraphMaterial;

/** The property values a draw of `image` gives a sprite graph: its texture and its secondary textures by name. */
export function spriteGraphOverrides(image: string): Record<string, GraphValue> {
  const path = image.replace(/^asset:/, "");
  const out: Record<string, GraphValue> = { "@sprite": path };
  if (path && Assets.has(path)) for (const [name, p] of Object.entries(Assets.importSettings(path).secondaryTextures)) out[`@secondary:${name}`] = p;
  return out;
}

/** What a draw's sprite graph material is keyed on: the graph, the image (and its sidecar) and the lighting. */
export const spriteGraphKey = (graph: SpriteGraph, image: string, litKey: string): string => `${graph.key}|${image}|${JSON.stringify(spriteGraphOverrides(image))}|${litKey}`;

/** A 2D draw's material for `graph`, drawing `image`, lit by `lit` (null: no light on its layer, or a Sprite Unlit graph). */
export function spriteGraphMaterial(make: SpriteGraphFactory, name: string, graph: SpriteGraph, image: string, lit: LitQuadSetup | null): BabylonGraphMaterial {
  const g = make(name, graph, spriteGraphOverrides(image));
  const m = g.material;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.depthFunction = Constants.ALWAYS;
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  const c = graph.compiled;
  if (c.target === "sprite-custom-lit") lightLayeredQuads(m, { ...(lit ?? { batch: -1, normal: null, mask: null, greenDown: false }), graph: { normal: false, mask: false, custom: true } });
  else if (c.target === "sprite-lit" && lit) lightLayeredQuads(m, { ...lit, graph: { normal: !!c.fragment.normal, mask: !!c.fragment.mask, custom: false } });
  return g;
}
