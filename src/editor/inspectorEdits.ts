// Inspector edits beyond field values (ADR 0033 §3, 0038): which Worlds a component is created
// in, and a node's tags. On plain nodes they edit the scene file's entries; on prefab instances,
// and nodes inside them, they become overrides (`worlds` on a component, `tags` on a node).
// Each edit is one undo step across every selected node.
import type { GameObject } from "../engine";
import { getComponentClass, getComponentOptions } from "../engine/core/registry";
import type { ProjectSettingsInput } from "../engine/core/settings";
import { listComponents, type ComponentInfo } from "../engine/editor";
import { originOf, prefabNodeEntry } from "./componentEdits";
import { SetComponentWorlds, SetOverrides, SetTags, sameTarget, type NodePath, type OverrideEntry, type SceneDocument } from "./document";
import type { OpenScene } from "./state";

/** Where a component's Worlds come from. */
export interface WorldsSetting {
  /** Set in this scene: the entry's `worlds` on a plain node or an added component, or an instance's override. */
  readonly own: readonly string[] | undefined;
  /** What applies without `own`: the prefab entry's `worlds`, else the component's `@behavior` option. Undefined: every World. */
  readonly inherited: readonly string[] | undefined;
}

const countOf = (node: GameObject, type: string) => listComponents(node).filter((c) => c.type === type).length;

/** A `worlds` override for component `index` of `type` at `target`. */
const isWorldsOverride = (o: OverrideEntry, target: readonly string[], type: string, index: number) =>
  o.component === type && o.field === undefined && o.worlds !== undefined && (o.index ?? 0) === index && sameTarget(o.target, target);

/** The class's own `worlds` option (ADR 0033 §3). */
function classWorlds(type: string): readonly string[] | undefined {
  const cls = getComponentClass(type);
  return cls ? getComponentOptions(cls).worlds : undefined;
}

/**
 * The Worlds setting of component `info` on the node at `path` (whose live node has `liveCount`
 * of that type), or null when it can't be set here: Transform, or a component the file doesn't
 * have (added by a script).
 */
export function componentWorlds(doc: SceneDocument, path: NodePath, info: ComponentInfo, liveCount: number): WorldsSetting | null {
  if (info.kind === "transform") return null;
  const origin = originOf(doc, path, info, liveCount);
  if (!origin) return null;
  const [id, ...target] = path;
  if (origin.kind === "file") return { own: doc.node(id).components![origin.position].worlds, inherited: classWorlds(info.type) };
  if (origin.kind === "added") return { own: doc.node(id).overrides![origin.at].addComponent!.worlds, inherited: classWorlds(info.type) };
  const override = doc.overrides(id).find((o) => isWorldsOverride(o, target, info.type, info.index));
  const prefabEntry = prefabNodeEntry(doc, id, target)?.components?.filter((c) => c.type === info.type)[info.index];
  return { own: override?.worlds, inherited: prefabEntry?.worlds ?? classWorlds(info.type) };
}

/** The Worlds that apply: own, else inherited. Undefined: every World. */
export const effectiveWorlds = (s: WorldsSetting): readonly string[] | undefined => s.own ?? s.inherited;

/** True when `worlds` admits every World (no filter, or the `*` wildcard). */
export const isEveryWorld = (worlds: readonly string[] | undefined) => worlds === undefined || worlds.includes("*");

/** Short text for the header badge, or null for every World. */
export function worldsBadge(worlds: readonly string[] | undefined): string | null {
  if (isEveryWorld(worlds)) return null;
  return worlds!.length === 0 ? "no Worlds" : worlds!.join(", ");
}

/**
 * Limit each component to Worlds with these tags (`["*"]`: every World), or with `undefined`
 * go back to the inherited setting, as one undo step. Returns how many changed.
 */
export function setComponentWorlds(scene: OpenScene, targets: readonly { path: NodePath; node: GameObject; info: ComponentInfo }[], worlds: readonly string[] | undefined): number {
  const { doc, stack } = scene;
  const able = targets.filter((t) => componentWorlds(doc, t.path, t.info, countOf(t.node, t.info.type)) !== null);
  if (able.length === 0) return 0;
  const label = worlds === undefined ? "Reset Worlds" : "Set Worlds";
  stack.beginGroup(able.length === 1 ? label : `${label} on ${able.length} nodes`);
  try {
    for (const { path, node, info } of able) {
      const [id, ...target] = path;
      const origin = originOf(doc, path, info, countOf(node, info.type))!;
      if (origin.kind === "file") {
        stack.execute(new SetComponentWorlds(id, origin.position, worlds));
        continue;
      }
      const list = structuredClone(doc.node(id).overrides ?? []);
      if (origin.kind === "added") {
        const entry = list[origin.at].addComponent!;
        if (worlds === undefined) delete entry.worlds;
        else entry.worlds = [...worlds];
      } else {
        const at = list.findIndex((o) => isWorldsOverride(o, target, info.type, info.index));
        if (at >= 0) list.splice(at, 1);
        if (worlds !== undefined) list.push({ ...(target.length > 0 ? { target: [...target] } : {}), component: info.type, ...(info.index > 0 ? { index: info.index } : {}), worlds: [...worlds] });
      }
      stack.execute(new SetOverrides(id, label, list));
    }
  } finally {
    stack.endGroup();
  }
  return able.length;
}

/** World tags to offer: client and server, plus every tag the project's bootstrap names. */
export function knownWorldTags(settings: ProjectSettingsInput | undefined, extra: readonly string[] = []): string[] {
  const tags = new Set(["client", "server"]);
  const bootstrap = settings?.bootstrap as { worlds?: { tags?: string[] }[]; templates?: Record<string, { tags?: string[] }> } | string | undefined;
  if (bootstrap && typeof bootstrap === "object") {
    for (const w of Array.isArray(bootstrap.worlds) ? bootstrap.worlds : []) for (const t of w?.tags ?? []) tags.add(t);
    for (const w of Object.values(bootstrap.templates ?? {})) for (const t of w?.tags ?? []) tags.add(t);
  }
  for (const t of extra) if (t !== "*") tags.add(t);
  tags.delete("editor"); // editor Worlds create every component
  return [...tags];
}

// --- tags -------------------------------------------------------------------------------------

/** True if `target` inside instance `id` has a `tags` override (or, for the instance itself, its own `tags`). */
export function tagsOverridden(doc: SceneDocument, path: NodePath): boolean {
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) return false;
  if (target.length === 0) return doc.node(id).tags !== undefined;
  return doc.overrides(id).some((o) => o.tags !== undefined && sameTarget(o.target, target));
}

/**
 * Set each node's tags (`tagsFor` gets the node's current tags), as one undo step: a plain node's
 * or an instance's own `tags`, or a `tags` override for a node inside an instance. `undefined`
 * goes back to the prefab's tags (instances only).
 */
export function setNodeTags(scene: OpenScene, paths: readonly NodePath[], tagsFor: (current: readonly string[]) => readonly string[] | undefined, label = "Set tags"): void {
  const { doc, stack } = scene;
  stack.beginGroup(paths.length === 1 ? label : `${label} on ${paths.length} nodes`);
  try {
    for (const path of paths) {
      const [id, ...target] = path;
      const current = scene.sync.nodeFor(path)?.tags ?? [];
      const next = tagsFor(current);
      if (next !== undefined && next.length === current.length && next.every((t, i) => t === current[i])) continue;
      if (target.length === 0) {
        if (next === undefined && !doc.isPrefabInstance(id)) continue;
        stack.execute(new SetTags(id, next));
        continue;
      }
      const list = structuredClone(doc.node(id).overrides ?? []).filter((o) => !(o.tags !== undefined && sameTarget(o.target, target) && Object.keys(o).every((k) => k === "tags" || k === "target")));
      if (next !== undefined) list.push({ target: [...target], tags: [...next] });
      stack.execute(new SetOverrides(id, label, list));
    }
  } finally {
    stack.endGroup();
  }
}

/** A tag typed by a person, cleaned: trimmed, inner whitespace collapsed. Empty if nothing's left. */
export function cleanTag(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
