// The Secondary Textures tab's rows (ADR 0414, 0415) as pure edits of an image's `secondaryTextures` map: the built-in
// normal and mask maps, and any number of custom named textures, which Sprite Custom Lit shader graphs read by name
// (the Secondary Texture node). A row without a texture is only on screen: the sidecar keeps textures, not names.
import { uniqueName } from "../../../engine/core/uniqueName";
import { SECONDARY_TEXTURE_NAMES, isSecondaryTextureName } from "../../../engine/scene/importSettings";

export type Textures = Readonly<Record<string, string>>;

const BUILT_IN: readonly string[] = SECONDARY_TEXTURE_NAMES;

/** The custom rows: the map's names past the built-in ones, then `pending` names not in it yet, in order. */
export function customRows(textures: Textures, pending: readonly string[]): string[] {
  const names = Object.keys(textures).filter((n) => !BUILT_IN.includes(n));
  return [...names, ...pending.filter((n) => !names.includes(n) && !BUILT_IN.includes(n))];
}

/** A new custom row's name, unique among the map's and `pending`. */
export function newTextureName(textures: Textures, pending: readonly string[]): string {
  const taken = new Set([...Object.keys(textures), ...pending, ...BUILT_IN]);
  const bare = (n: string) => n.replace(/\s+/g, ""); // "_Texture 2" → "_Texture2": a name graphs can read
  return bare(uniqueName("_Texture", (n) => taken.has(bare(n))));
}

/** Why `to` can't rename `from` (empty: it can). */
export function renameProblem(textures: Textures, pending: readonly string[], from: string, to: string): string {
  if (to === from) return "";
  if (!isSecondaryTextureName(to)) return "A name of letters, digits and _, not starting with a digit.";
  if (BUILT_IN.includes(to) || to in textures || pending.includes(to)) return `There's already a texture named ${to}.`;
  return "";
}

/** The map with `from` renamed `to` (in place, keeping its order), or the map as it was when it can't be. */
export function renameTexture(textures: Textures, pending: readonly string[], from: string, to: string): Record<string, string> {
  if (renameProblem(textures, pending, from, to) || !(from in textures)) return { ...textures };
  return Object.fromEntries(Object.entries(textures).map(([n, v]) => [n === from ? to : n, v]));
}

/** The map without `name`. */
export function removeTexture(textures: Textures, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(textures).filter(([n]) => n !== name));
}
