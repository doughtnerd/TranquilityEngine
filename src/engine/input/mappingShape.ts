// The shape of a mapping (ADR 0458): which parts each composite (single, dpad, axis, modifier) has, the
// control path each part holds, and a mapping with some parts replaced. A part is what a rebind, a
// profile override (`<context>/<mapping>/<action>/<part>`, on disk) and a prompt name: `control`; `up`,
// `down`, `left`, `right`; `negative`, `positive`; a chord's `modifier0`… then `control`. A field is
// what the `*.input.json` asset holds: the same, except that a chord keeps its modifiers in one
// `modifier` field, a path or a list of paths.
import type { MappingSpec } from "./contextTypes";

/** A mapping's shape: a single control or one of the composites. */
export type MappingShape = "single" | "dpad" | "axis" | "modifier";

/** Each shape's fields, in control order (a chord's `modifier` field holds its modifiers, before its control). */
const FIELDS: Record<MappingShape, readonly string[]> = {
  single: ["control"],
  dpad: ["up", "down", "left", "right"],
  axis: ["negative", "positive"],
  modifier: ["modifier", "control"],
};

/** Every field a shape may read, across the shapes. */
export const MAPPING_FIELDS: readonly string[] = ["control", "up", "down", "left", "right", "negative", "positive", "modifier"];

/** A mapping's shape; null when its `composite` names none (a hand-edited file). */
export function shapeOf(spec: MappingSpec): MappingShape | null {
  const c = (spec.composite as string | undefined) ?? "single";
  return c in FIELDS ? (c as MappingShape) : null;
}

/** The fields a shape reads, in control order. */
export const shapeFields = (shape: MappingShape): readonly string[] => FIELDS[shape];

/** A chord's modifier paths, one or several given as a list; empty for any other shape. */
export function modifierList(spec: MappingSpec): string[] {
  if (spec.composite !== "modifier") return [];
  return typeof spec.modifier === "string" ? [spec.modifier] : [...(spec.modifier ?? [])];
}

/** The part name of a chord's `i`th modifier. */
export const modifierPart = (i: number): string => `modifier${i}`;

/** A mapping's part names, in control order (empty for an unknown shape). */
export function partsOf(spec: MappingSpec): string[] {
  const shape = shapeOf(spec);
  if (!shape) return [];
  if (shape === "modifier") return [...modifierList(spec).map((_, i) => modifierPart(i)), "control"];
  return [...FIELDS[shape]];
}

/** A part's control path, or undefined when the mapping has no such part or leaves it unset. */
export function partPath(spec: MappingSpec, part: string): string | undefined {
  const shape = shapeOf(spec);
  if (!shape) return undefined;
  const mod = /^modifier(\d+)$/.exec(part);
  if (mod) return modifierList(spec)[Number(mod[1])];
  if (part === "modifier" || !FIELDS[shape].includes(part)) return undefined;
  const v = (spec as unknown as Record<string, unknown>)[part];
  return typeof v === "string" ? v : undefined;
}

/** A mapping's control paths, in control order, without the unset ones. */
export function controlPaths(spec: MappingSpec): string[] {
  return partsOf(spec)
    .map((p) => partPath(spec, p))
    .filter((p): p is string => !!p);
}

/** A mapping with some parts' control paths replaced; parts its shape doesn't have (a modifier past its count) are ignored. */
export function withParts(spec: MappingSpec, parts: Readonly<Record<string, string>>): MappingSpec {
  const shape = shapeOf(spec);
  if (!shape) return spec;
  const out: Record<string, unknown> = { ...spec };
  let mods: string[] | null = null;
  for (const [part, path] of Object.entries(parts)) {
    const mod = /^modifier(\d+)$/.exec(part);
    if (mod) {
      mods ??= modifierList(spec);
      const i = Number(mod[1]);
      if (i < mods.length) {
        mods[i] = path;
        out.modifier = mods;
      }
    } else if (part !== "modifier" && FIELDS[shape].includes(part)) out[part] = path;
  }
  return out as unknown as MappingSpec;
}
