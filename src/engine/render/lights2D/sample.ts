/**
 * The 2D light at a point, on the CPU (ADR 0399 open question 4, built with it): what `Light2D.sampleAt` returns. It
 * reads the lights' fields with the same rules the light pass draws by (`lightShapes.ts`, `shadowGeometry.ts`), so a
 * game can ask how lit a place is (stealth, plants that grow toward light) without reading pixels back from the GPU.
 *
 * Differences from what's drawn, by design: normal maps aren't applied (the result is the flat light), shadows are hard
 * (softness is a screen-space filter), and a sprite light counts as its rectangle (its texture isn't read on the CPU).
 */
import { srgbToLinear } from "../../core/colorSpace";
import { Color } from "../../core/math";
import type { World } from "../../core/World";
import type { Point2 } from "../../physics/polygon";
import { Assets } from "../../scene/Assets";
import { splitSpriteRef } from "../../scene/importSettings";
import { CompositeShadowCaster2D, Light2D, ShadowCaster2D } from "../components";
import { spriteFrame } from "../spriteFrame";
import { casterGroups, casterOutline, type TextureSizeOf } from "./casterOutlines";
import { freeformAttenuation, pointAttenuation } from "./lightShapes";
import { blendStyleIndex, masksOverlap } from "./settings";
import { outlineSegments, shadowFactor, unionSegments, type WorldCaster } from "./shadowGeometry";

/** A 2D affine `[a, b, c, d, tx, ty]` (x' = a·x + c·y + tx, y' = b·x + d·y + ty) from a column-major 4×4 at `o`. */
export function affineOf(m: ArrayLike<number>, o = 0): [number, number, number, number, number, number] {
  return [m[o]!, m[o + 1]!, m[o + 4]!, m[o + 5]!, m[o + 12]!, m[o + 13]!];
}

/** World (x, y) into the affine's local space, or null when it can't be inverted (a zero scale). */
export function toLocal(t: readonly number[], x: number, y: number): [number, number] | null {
  const [a, b, c, d, tx, ty] = t as [number, number, number, number, number, number];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const dx = x - tx, dy = y - ty;
  return [(d * dx - c * dy) / det, (-b * dx + a * dy) / det];
}

const applyAffine = (t: readonly number[], p: Point2): Point2 => [t[0]! * p[0] + t[2]! * p[1] + t[4]!, t[1]! * p[0] + t[3]! * p[1] + t[5]!];

/** Whether a light or caster targeting `layers` (empty: all) covers `layer`. */
export const targetsLayer = (layers: readonly string[], layer: string): boolean => layers.length === 0 || layers.includes(layer);

/** The light at world (x, y) on `sortingLayer` through blend style `blendStyle` (default the first), as linear RGB. */
export function sampleLights2D(world: World, x: number, y: number, sortingLayer: string, blendStyle?: string): Color {
  const settings = world.settings.lighting2D;
  const style = blendStyle === undefined ? 0 : blendStyleIndex(settings, blendStyle);
  const textureSize: TextureSizeOf = (path) => world.render?.textureSize?.(path) ?? null;
  let casters: WorldCaster[] | null = null;
  const out = new Color(0, 0, 0, 1);
  for (const light of world._componentsOfType(Light2D)) {
    if (!light.isActiveAndEnabled || !targetsLayer(light.targetSortingLayers, sortingLayer) || blendStyleIndex(settings, light.blendStyle) !== style) continue;
    let k = 0;
    const t = affineOf(world.worldMatrix(light.node.entity), light.node.entity * 16);
    if (light.type === "global") k = 1;
    else {
      const local = toLocal(t, x, y);
      if (!local) continue;
      if (light.type === "point") k = pointAttenuation(light, local[0], local[1]);
      else if (light.type === "freeform") k = freeformAttenuation(light.shape.map((p): Point2 => [p.x, p.y]), light.falloffSize, local[0], local[1]);
      else k = insideSpriteLight(world, light, local[0], local[1], textureSize) ? 1 : 0;
      if (k > 0 && light.shadows && light.shadowStrength > 0) {
        casters ??= worldCasters(world, sortingLayer, textureSize);
        const lit = shadowFactor(t[4], t[5], x, y, casters.filter((c) => masksOverlap(light.shadowMask, c.mask ?? [])));
        k *= 1 - Math.min(Math.max(light.shadowStrength, 0), 1) * (1 - lit);
      }
    }
    if (k <= 0) continue;
    const i = Math.max(light.intensity, 0) * k;
    out.r += srgbToLinear(light.color.r) * i;
    out.g += srgbToLinear(light.color.g) * i;
    out.b += srgbToLinear(light.color.b) * i;
  }
  return out;
}

function insideSpriteLight(world: World, light: Light2D, x: number, y: number, textureSize: TextureSizeOf): boolean {
  const { path, slice } = splitSpriteRef(light.sprite);
  const size = path ? textureSize(path) : null;
  if (!path || !size) return Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5;
  const f = spriteFrame(Assets.importSettings(path), slice, size[0], size[1], { component: 0, project: world.settings.render.pixelsPerUnit });
  const [w, h] = f.size, [px, py] = f.pivot;
  return x >= -px * w && x <= (1 - px) * w && y >= -py * h && y <= (1 - py) * h;
}

/** Every enabled caster (or composite, ADR 0415) that shadows `sortingLayer`, in world XY. */
function worldCasters(world: World, sortingLayer: string, textureSize: TextureSizeOf): WorldCaster[] {
  const out: WorldCaster[] = [];
  const casters = world._componentsOfType(ShadowCaster2D).filter((c) => c.isActiveAndEnabled);
  for (const g of casterGroups(world, casters, (c) => c instanceof CompositeShadowCaster2D)) {
    const s = g.settings;
    if (!s.castShadows || !targetsLayer(s.targetSortingLayers, sortingLayer)) continue;
    const loops: Point2[][] = [], chains: Point2[][] = [], owner: number[] = [];
    g.members.forEach((c, mi) => {
      if (!g.composite && !c.castShadows) return;
      const o = casterOutline(world, c, textureSize);
      const t = affineOf(world.worldMatrix(c.node.entity), c.node.entity * 16);
      for (const l of o.loops) {
        loops.push(l.map((p) => applyAffine(t, p)));
        owner.push(mi);
      }
      for (const l of o.chains) chains.push(l.map((p) => applyAffine(t, p)));
    });
    if (!loops.length && !chains.length) continue;
    const segs = g.composite ? concat(unionSegments(loops, owner), outlineSegments([], chains)) : outlineSegments(loops, chains);
    out.push({ segments: segs, loops, selfShadows: s.selfShadows, mask: s.shadowMask });
  }
  return out;
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
