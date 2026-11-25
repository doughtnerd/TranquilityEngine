// What a Sprite Editor tool may change, and how (ADR 0373 "2D tools"; T56): a tool's `SpriteEditorChange` applied to the
// editor's state (slice skins by name, the image's flipbooks), and a slice rename followed through the flipbooks that show
// it. Pure, so the editor's history steps are tested without its UI.
import type { SliceSkin, SpriteFlipbook } from "../engine/animation/sprites/sidecar";
import type { SpriteEditorChange } from "./sdk/contributions";

/** A slice's outline (ADR 0414): closed polygons in slice pixels, y up. */
type Outline = [number, number][][];

/** The slices, flipbooks and secondary textures one undo step of the Sprite Editor holds, as far as tools touch them. */
export interface ToolState<S extends { name: string; skin?: SliceSkin; outline?: Outline }> {
  slices: S[];
  flipbooks: Record<string, SpriteFlipbook>;
  /** The image's secondary textures and normal map green channel (ADR 0414). */
  secondary: { textures: Record<string, string>; normalMapGreen: "up" | "down" };
}

/**
 * `state` with `change` made: skins and outlines set (or dropped for null) on the slices they name, flipbooks and
 * secondary textures replaced as a whole. A skin or outline for a slice that isn't there is ignored; nothing else of a
 * slice changes.
 */
export function applyToolChange<S extends { name: string; skin?: SliceSkin; outline?: Outline }>(state: ToolState<S>, change: SpriteEditorChange): ToolState<S> {
  const { skins, outlines } = change;
  let slices = skins ? state.slices.map((s) => (s.name in skins ? { ...s, skin: skins[s.name] ?? undefined } : s)) : state.slices;
  if (outlines) slices = slices.map((s) => (s.name in outlines ? { ...s, outline: outlines[s.name]?.map((poly) => poly.map((p): [number, number] => [p[0], p[1]])) ?? undefined } : s));
  return {
    slices,
    flipbooks: change.flipbooks ? { ...change.flipbooks } : state.flipbooks,
    secondary: {
      textures: change.secondaryTextures ? Object.fromEntries(Object.entries(change.secondaryTextures).filter(([, v]) => v)) : state.secondary.textures,
      normalMapGreen: change.normalMapGreen ?? state.secondary.normalMapGreen,
    },
  };
}

/** `flipbooks` with each slice named by `renames` (`[from, to]` pairs) called its new name in every flipbook that shows it. */
export function renameInFlipbooks(flipbooks: Readonly<Record<string, SpriteFlipbook>>, renames: readonly (readonly [string, string])[]): Record<string, SpriteFlipbook> {
  const by = new Map(renames);
  return Object.fromEntries(Object.entries(flipbooks).map(([name, f]) => [name, f.slices.some((n) => by.has(n)) ? { ...f, slices: f.slices.map((n) => by.get(n) ?? n) } : f]));
}
