/**
 * Animation binding paths (ADR 0452): the one place that knows how a track's or tween's target is written — a node
 * path relative to the Animator's (or director's) node and a field path on one of its components — and what each part
 * means. The runtime's property bindings and tweens and the editor's Animation and Timeline windows all read paths here.
 *
 * - **Node paths** are child names joined by `/`; "" is the root itself and empty parts are skipped. Each step takes the
 *   **first** child with that name (siblings sharing a name are an ambiguity the Timeline window flags, not an error).
 * - **Field paths** are a declared field (`head`) optionally followed by a dotted sub-path into a plain-object value
 *   (`drive.targetRotation`, D86). Two forms name a MeshRenderer's material property instead: `material.<name>` (the
 *   renderer's override) and `materials[N].<name>` (slot N's override, the form model imports emit); whether the
 *   component is a MeshRenderer is the caller's question, the syntax is answered here.
 * - **Which tracks bind a field:** the property kinds (`float` … `discrete`) whose target names a component.
 *
 * Pure: no engine objects, so the runtime and the editor can both import it.
 */
import type { Binding, Track } from "./tracks";

/** What a node path needs of a node (a `GameObject` is one). */
export interface PathNode<N> {
  readonly name: string;
  readonly parent: N | null;
  readonly children: readonly N[];
}

/** Told about each step a resolution takes: `child` is the node `part` named under `parent`, or null when none is. */
export type NodePathStep<N> = (parent: N, part: string, child: N | null) => void;

/** The node at `path` under `root` ("" is `root`), or null when a step names no child; `step` sees every step taken. */
export function resolveNodePath<N extends PathNode<N>>(root: N, path: string, step?: NodePathStep<N>): N | null {
  let node = root;
  for (const part of path.split("/")) {
    if (!part) continue;
    const next = node.children.find((c) => c.name === part) ?? null;
    step?.(node, part, next);
    if (!next) return null;
    node = next;
  }
  return node;
}

/** `node`'s path relative to `root` ("" for `root` itself), or null when it isn't under it. */
export function nodePathOf<N extends PathNode<N>>(root: N, node: N): string | null {
  const names: string[] = [];
  for (let n: N | null = node; n; n = n.parent) {
    if (n === root) return names.reverse().join("/");
    names.push(n.name);
  }
  return null;
}

/** A field path read apart. */
export interface FieldPath {
  /** The declared field (the part before the first dot). */
  readonly head: string;
  /** The dotted sub-path inside the field's value (D86); empty for the field itself. */
  readonly sub: readonly string[];
  /** For `material.<name>` (no slot) and `materials[N].<name>`: the material property it names on a MeshRenderer. */
  readonly material?: { readonly name: string; readonly slot?: number };
}

const SLOT_PROPERTY = /^materials\[(\d+)\]\.(.+)$/;

/** `field` read apart (see the file header). */
export function parseFieldPath(field: string): FieldPath {
  const dot = field.indexOf(".");
  const head = dot < 0 ? field : field.slice(0, dot);
  const sub = dot < 0 ? [] : field.slice(dot + 1).split(".");
  if (head === "material" && dot >= 0) return { head, sub, material: { name: field.slice(dot + 1) } };
  const slotted = SLOT_PROPERTY.exec(field);
  if (slotted) return { head, sub, material: { name: slotted[2]!, slot: Number(slotted[1]) } };
  return { head, sub };
}

/** The value `field` names inside `headValue` (its head field's value): `headValue` itself, or what its sub-path reaches (undefined when it reaches nothing). */
export function fieldPathValue(headValue: unknown, field: string): unknown {
  let v = headValue;
  for (const part of parseFieldPath(field).sub) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

const PROPERTY_KINDS: ReadonlySet<string> = new Set(["float", "vec2", "vec3", "vec4", "color", "quat", "discrete"]);

/** The component field `track` writes, or null for a track that writes none (bones, morphs, markers, events, …). */
export function trackBinding(track: Track): Binding | null {
  if (!PROPERTY_KINDS.has(track.kind)) return null;
  const target = (track as { readonly target: Binding }).target;
  return target.component ? target : null;
}
