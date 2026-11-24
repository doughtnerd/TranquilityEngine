// Inspector edits beyond field values (ADR 0033 §3, 0038): which Worlds a component is created
// in, and a node's tags. On plain nodes they edit the scene file's entries; on prefab instances,
// and nodes inside them, they become overrides (`worlds` on a component, `tags` on a node).
// Each edit is one undo step across every selected node.
import type { GameObject } from "../engine";
import { getComponentClass, getComponentOptions } from "../engine/core/registry";
import type { ProjectSettingsInput } from "../engine/core/settings";
import type { ComponentInfo } from "../engine/editor";
import type { NodePath, SceneDocument } from "./document";
import { inheritedValue, originOf, writeProperty, writtenValue } from "./overrideWriter";
import type { OpenScene } from "./state";
import { editableNow } from "./editGate";
import { undoStep } from "./undoStep";

/** Where a component's Worlds come from. */
export interface WorldsSetting {
  /** Set in this scene: the entry's `worlds` on a plain node or an added component, or an instance's override. */
  readonly own: readonly string[] | undefined;
  /** What applies without `own`: the prefab entry's `worlds`, else the component's `@behavior` option. Undefined: every World. */
  readonly inherited: readonly string[] | undefined;
}

/** The Worlds property of component `info` (the override writer's word for it, ADR 0287). */
const worldsOf = (info: Pick<ComponentInfo, "type" | "index">) => ({ kind: "worlds", type: info.type, index: info.index }) as const;

/** The class's own `worlds` option (ADR 0033 §3). */
function classWorlds(type: string): readonly string[] | undefined {
  const cls = getComponentClass(type);
  return cls ? getComponentOptions(cls).worlds : undefined;
}

/**
 * The Worlds setting of component `info` on the node at `path`, or null when it can't be set
 * here: Transform, or a component the file doesn't have (added by a script).
 */
export function componentWorlds(doc: SceneDocument, path: NodePath, info: ComponentInfo): WorldsSetting | null {
  if (info.kind === "transform" || !originOf(doc, path, info)) return null;
  const p = worldsOf(info);
  // Inside an instance, what the prefab files give it (their entries and nested instances' overrides).
  const inherited = inheritedValue(doc, path, p) as readonly string[] | undefined;
  return { own: writtenValue(doc, path, p) as readonly string[] | undefined, inherited: inherited ?? classWorlds(info.type) };
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

/** True when two Worlds settings admit the same Worlds (every World, or the same tags in any order). */
const sameWorlds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  isEveryWorld(a) === isEveryWorld(b) && (isEveryWorld(a) || (a!.length === b!.length && a!.every((t) => b!.includes(t))));

/** `worlds` with `tag` ticked or unticked; unticking from every World leaves no Worlds. */
export function withWorldTag(worlds: readonly string[] | undefined, tag: string, on: boolean): string[] {
  const base = isEveryWorld(worlds) ? [] : worlds!.filter((t) => t !== tag);
  return on ? [...base, tag] : base;
}

/**
 * Limit each component to Worlds with these tags (`["*"]`: every World), or with `undefined`
 * go back to the inherited setting, as one undo step (labelled `label` when given). Given a
 * function, each component's tags are worked out from the Worlds that apply to it now (so
 * ticking a tag on several nodes adds it to each node's own list). Where the
 * tags match what a component inherits, its own setting is dropped instead of repeating it; a
 * component already so is left alone. Returns how many changed.
 */
export function setComponentWorlds(
  scene: OpenScene,
  targets: readonly { path: NodePath; node: GameObject; info: ComponentInfo }[],
  worlds: readonly string[] | undefined | ((current: readonly string[] | undefined) => readonly string[] | undefined),
  label?: string,
): number {
  if (!editableNow({ kind: "scene", scene })) return 0;
  const { doc, stack } = scene;
  const able = targets.flatMap((t) => {
    const setting = componentWorlds(doc, t.path, t.info);
    if (!setting) return [];
    const wanted = typeof worlds === "function" ? worlds(effectiveWorlds(setting)) : worlds;
    const next = wanted === undefined || sameWorlds(wanted, setting.inherited) ? undefined : wanted;
    const unchanged = next === undefined ? setting.own === undefined : setting.own !== undefined && sameWorlds(next, setting.own);
    return unchanged ? [] : [{ ...t, next }];
  });
  if (able.length === 0) return 0;
  const verb = worlds === undefined ? "Reset Worlds" : "Set Worlds";
  undoStep(stack, label ?? (able.length === 1 ? verb : `${verb} on ${able.length} nodes`), () => {
    for (const { path, info, next } of able) {
      const command = writeProperty(doc, path, worldsOf(info), next === undefined ? undefined : [...next], verb);
      if (command) stack.execute(command);
    }
  });
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

/** A node's tags, as the override writer (ADR 0287) names them: `isOverridden(doc, path, TAGS)` says whether a node's tags are this scene's own. */
export const TAGS = { kind: "tags" } as const;

/**
 * Set each node's tags (`tagsFor` gets the node's current tags), as one undo step: a plain node's
 * or an instance's own `tags`, or a `tags` override for a node inside an instance. `undefined`
 * goes back to the prefab's tags (instances only).
 */
export function setNodeTags(scene: OpenScene, paths: readonly NodePath[], tagsFor: (current: readonly string[]) => readonly string[] | undefined, label = "Set tags"): void {
  if (!editableNow({ kind: "scene", scene })) return;
  const { doc, stack } = scene;
  undoStep(stack, paths.length === 1 ? label : `${label} on ${paths.length} nodes`, () => {
    for (const path of paths) {
      const current = scene.sync.nodeFor(path)?.tags ?? [];
      const next = tagsFor(current);
      if (next !== undefined && next.length === current.length && next.every((t, i) => t === current[i])) continue;
      const command = writeProperty(doc, path, TAGS, next === undefined ? undefined : [...next], label);
      if (command) stack.execute(command);
    }
  });
}

/** A tag typed by a person, cleaned: trimmed, inner whitespace collapsed. Empty if nothing's left. */
export function cleanTag(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
