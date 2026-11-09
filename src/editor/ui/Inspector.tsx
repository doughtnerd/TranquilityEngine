import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listComponents, type ComponentInfo } from "../../engine/editor";
import { pathKey, type NodePath } from "../document";
import { documentFieldTarget } from "../fieldTarget";
import {
  cleanTag,
  effectiveWorlds,
  isEveryWorld,
  knownWorldTags,
  setComponentWorlds,
  setNodeTags,
  setWorldsFor,
  tagsOverridden,
  worldsBadge,
  worldsSettingOf,
  type WorldsSetting,
  type WorldsTarget,
} from "../inspectorEdits";
import "./inspector-fields.css";
import {
  disabledPluginOf,
  inFileOrder,
  missingBadge,
  moveComponent,
  removeComponentFrom,
  removeMissingComponent,
  setComponentEnabled,
  whyNotRemovable,
  whyNotRemovableMissing,
  whyNotReorderable,
  whyNotToggleable,
} from "../componentEdits";
import { deleteSelected } from "../deleteSelection";
import { AddComponentMenu } from "./AddComponentMenu";
import { AssetInspector } from "./AssetInspector";
import { showsAssetInspector } from "../assetImport";
import { listedFiles } from "../assetBrowser";
import { isHiddenField } from "../assetFieldKinds";
import { AssetLists, FieldRows, MIXED, TextInput } from "./fieldRows";
import { CreatePrefabButton, MultiPrefabActions, OpenPrefabButton, PrefabActions } from "./PrefabActions";
import { InspectorSections } from "./inspectorSections";
import "./inspectorSections.builtin";
import { liveInspecting } from "../runtimeInspect";
import { addToPreload, preloadCandidates, removeFromPreload } from "../scenePreload";
import { RuntimeInspector } from "./RuntimeInspector";
import { UIElementInspector } from "./UIElementInspector";
import { openScript, scriptFor } from "../code/codeState";
import { findInner, isInnerPropertyOverridden, nodePropertyCommand, revertInnerProperty } from "../prefabs";
import { currentProject, docVersion, openScene, scriptsVersion, selectedKeys, selectedUIElement, status, type OpenScene } from "../state";
import { componentHeaderActions, type ComponentHeaderActionContribution } from "../sdk/contributions";

/**
 * The selected node's components with their declared fields and live values (ADR 0022, 0026).
 * Every edit is a command on the open document, so it can be undone. On a prefab instance, or a
 * node inside one, edits become overrides: overridden fields are marked and can be reverted, and
 * the instance's overrides can be applied to the prefab file. With several nodes selected it
 * shows the components they all have; fields that differ show a dash, and an edit sets every
 * selected node in one undo step.
 */
export function Inspector() {
  if (liveInspecting()) return <RuntimeInspector />; // a live World of the running game
  if (showsAssetInspector()) return <AssetInspector />; // an image or audio file selected in the Assets panel (ADR 0040)
  if (selectedUIElement.value !== null) return <UIElementInspector />; // an element of a UI document (ADR 0077)
  docVersion.value; // re-render when the document changes
  const scene = openScene.value;
  if (!scene) return <p class="empty">Nothing selected</p>;
  // Selected nodes that still exist (an undo may have removed some).
  const paths = selectedKeys.value
    .map((k) => k.split("/") as NodePath)
    .filter((p) => scene.doc.has(p[0]) && (p.length === 1 || findInner(scene.doc, p)));
  if (paths.length === 0) return <SceneSettings scene={scene} />;
  if (paths.length > 1) return <MultiInspector scene={scene} paths={paths} />;
  const path = paths[0];
  const inner = path.length > 1 ? findInner(scene.doc, path) : null;

  const id = path[0];
  const entry = scene.doc.node(id);
  const node = scene.sync.nodeFor(path);
  const components = node ? inFileOrder(scene.doc, id, listComponents(node)) : [];
  const key = pathKey(path);
  return (
    <div class="inspector-body">
      <AssetLists />
      <div class="node-header">
        <input
          type="checkbox"
          class={inner && isInnerPropertyOverridden(scene.doc, path, "active") ? "overridden" : undefined}
          checked={inner ? inner.active : entry.active !== false}
          aria-label="Active"
          title={inner ? "Inside a prefab instance: switching it is an override" : undefined}
          onChange={(e) => scene.stack.execute(nodePropertyCommand(scene.doc, path, "active", (e.currentTarget as HTMLInputElement).checked))}
        />
        <TextInput
          class={`node-name${inner ? " inner-name" : ""}${inner && isInnerPropertyOverridden(scene.doc, path, "name") ? " overridden" : ""}`}
          value={inner ? inner.name : (entry.name ?? id)}
          label="Name"
          onCommit={(name) => name !== (inner ? inner.name : (entry.name ?? id)) && scene.stack.execute(nodePropertyCommand(scene.doc, path, "name", name))}
        />
        {inner && (isInnerPropertyOverridden(scene.doc, path, "name") || isInnerPropertyOverridden(scene.doc, path, "active")) && (
          <button
            class="revert node-revert"
            aria-label="Revert name and active"
            title="Name or active overridden in this scene. Revert to the prefab's"
            onClick={() =>
              scene.stack.group("Revert name and active", () => {
                for (const key of ["name", "active"] as const) if (isInnerPropertyOverridden(scene.doc, path, key)) revertInnerProperty(scene, path, key);
              })
            }
          >
            ↺
          </button>
        )}
        {!inner && (
          <button class="delete-node" title="Delete this node and its children (Delete)" aria-label="Delete node" onClick={() => void deleteSelected()}>
            Delete
          </button>
        )}
      </div>
      <dl class="node-meta">
        <dt>Id</dt>
        <dd>{key}</dd>
        {entry.prefab && (
          <>
            <dt>{inner ? "Inside" : "Prefab"}</dt>
            <dd>{entry.prefab}</dd>
          </>
        )}
      </dl>
      <NodeTags scene={scene} paths={[path]} />
      {entry.prefab && !inner && <PrefabActions scene={scene} id={id} />}
      {entry.prefab && inner && (
        <div class="prefab-actions">
          <span class="override-count">Inside {entry.prefab.split("/").pop()}</span>
          <OpenPrefabButton path={path} />
        </div>
      )}
      {!entry.prefab && <CreatePrefabButton scene={scene} id={id} />}
      {components.map((c) => (
        <ComponentCard key={`${key}/${c.type}#${c.index}`} scene={scene} paths={[path]} infos={[c]} siblings={components} />
      ))}
      <MissingComponents scene={scene} path={path} />
      {node && <AddComponentMenu scene={scene} targets={[{ path, node }]} />}
    </div>
  );
}

/**
 * With no node selected, the open scene's own settings: its warm-up preload list (ADR 0080), the
 * prefabs and materials scripts pick at runtime, so their shaders compile while the scene loads.
 */
function SceneSettings(props: { scene: OpenScene }) {
  const { scene } = props;
  const list = scene.doc.preload;
  const [draft, setDraft] = useState("");
  const version = docVersion.value;
  const project = currentProject.value;
  const candidates = useMemo(() => preloadCandidates(listedFiles(project?.files ?? [])).filter((f) => !list.includes(f)), [project, version, project?.files, list]);
  const add = () => {
    const path = draft.trim().replace(/^asset:/, "");
    if (!path) return;
    if (list.includes(path)) status.value = { kind: "info", text: `${path} is already on the preload list.` };
    else if (!addToPreload(scene, path)) status.value = { kind: "error", text: `The preload list takes prefabs and materials (.prefab.json, .material.json), not ${path}.` };
    setDraft("");
  };
  return (
    <div class="inspector-body scene-settings">
      <p class="empty">Nothing selected</p>
      <section class="component" aria-label="Scene settings">
        <h3>Scene settings</h3>
        <div class="scene-setting-label">Preload</div>
        <p class="scene-setting-hint">Prefabs and materials scripts spawn by a computed path. Their shaders compile while the scene loads, so they don't stall a frame the first time they draw.</p>
        <ul class="preload-list" aria-label="Preload list">
          {list.length === 0 && <li class="empty">Nothing listed. The warm-up already covers the scene's own content and paths written in scripts.</li>}
          {list.map((p) => (
            <li key={p}>
              <span class="preload-path" title={p}>
                {p}
              </span>
              <button class="remove-component" aria-label={`Remove ${p} from the preload list`} title="Remove" onClick={() => removeFromPreload(scene, p)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <div class="preload-add">
          <input
            type="text"
            list="preload-candidates"
            aria-label="Add to the preload list"
            placeholder="prefabs/boss.prefab.json"
            value={draft}
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button disabled={!draft.trim()} onClick={add}>
            Add
          </button>
          <datalist id="preload-candidates">
            {candidates.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      </section>
    </div>
  );
}

/** Several nodes: their names, a shared active toggle, Delete, and the components they all have. */
function MultiInspector(props: { scene: OpenScene; paths: NodePath[] }) {
  const { scene, paths } = props;
  const nodes = paths.map((p) => scene.sync.nodeFor(p));
  const lists = nodes.map((n) => (n ? listComponents(n) : []));
  // Components every node has, matched by type and index, in the active (last) node's order.
  const shared = lists[lists.length - 1].filter((c) => lists.every((l) => l.some((o) => o.type === c.type && o.index === c.index)));
  const names = paths.map((p, i) => nodes[i]?.name ?? p[p.length - 1]);
  const anyInner = paths.some((p) => p.length > 1);
  const actives = paths.map((p) => (p.length > 1 ? (findInner(scene.doc, p)?.active ?? true) : scene.doc.node(p[0]).active !== false));
  const allActive = actives.every(Boolean);
  const key = paths.map(pathKey).join("|");
  return (
    <div class="inspector-body">
      <AssetLists />
      <MultiPrefabActions scene={scene} paths={paths} />
      <div class="node-header">
        <input
          type="checkbox"
          checked={allActive}
          indeterminate={!allActive && actives.some(Boolean)}
          aria-label="Active"
          title={anyInner ? "Nodes inside a prefab instance are switched as overrides" : undefined}
          onChange={(e) => {
            const on = (e.currentTarget as HTMLInputElement).checked;
            scene.stack.group(`${on ? "Activate" : "Deactivate"} ${paths.length} nodes`, () => {
              for (const p of paths) scene.stack.execute(nodePropertyCommand(scene.doc, p, "active", on));
            });
          }}
        />
        <span class="node-name multi-name">{paths.length} nodes selected</span>
        {!anyInner && (
          <button class="delete-node" title="Delete these nodes and their children (Delete)" aria-label="Delete nodes" onClick={() => void deleteSelected()}>
            Delete
          </button>
        )}
      </div>
      <p class="multi-names" title={names.join(", ")}>
        {names.join(", ")}
      </p>
      <NodeTags scene={scene} paths={paths} />
      {shared.length === 0 && <p class="empty">No components in common</p>}
      {shared.map((c) => (
        <ComponentCard
          key={`${key}/${c.type}#${c.index}`}
          scene={scene}
          paths={paths}
          infos={lists.map((l) => l.find((o) => o.type === c.type && o.index === c.index)!)}
        />
      ))}
      <AddComponentMenu scene={scene} targets={paths.flatMap((path, i) => (nodes[i] ? [{ path, node: nodes[i]! }] : []))} />
    </div>
  );
}

/**
 * Components whose type isn't registered (their script was deleted, renamed or didn't load, ADR
 * 0030). The scene keeps their data; each card says so and can remove the component.
 */
function MissingComponents(props: { scene: OpenScene; path: NodePath }) {
  docVersion.value; // a script reload rebuilds the scene without changing these props
  const { scene, path } = props;
  const missing = scene.sync.missingComponents(path);
  if (missing.length === 0) return null;
  const seen = new Map<string, number>();
  return (
    <>
      {missing.map((entry) => {
        const k = seen.get(entry.type) ?? 0;
        seen.set(entry.type, k + 1);
        const count = missing.filter((m) => m.type === entry.type).length;
        const reason = whyNotRemovableMissing(scene.doc, path, entry.type, k, count);
        const name = entry.type.replace(/^[^.]*\./, "");
        return (
          <section key={`${entry.type}#${k}`} class="component missing">
            <h3>
              <span class="missing-mark" aria-hidden="true">⚠</span>
              {name}
              <span class="badge">{missingBadge(entry.type)}</span>
              <button
                class="remove-component"
                aria-label={`Remove ${name}`}
                title={reason ? `Can't remove: ${reason}` : `Remove ${name} from this node`}
                disabled={reason !== null}
                onClick={() => removeMissingComponent(scene, path, entry.type, k, count)}
              >
                ✕
              </button>
            </h3>
            <p class="missing-note">
              {disabledPluginOf(entry.type) !== null ? (
                <>
                  The plugin {disabledPluginOf(entry.type)} is disabled in Project settings, so <code>{entry.type}</code> isn't available. Its data stays in the scene, and it comes back when the plugin is enabled.
                </>
              ) : (
                <>
              No script registers <code>{entry.type}</code>: it was deleted or renamed, or it didn't load. Its data stays in the scene, and it comes back
              when the script does.
                </>
              )}
            </p>
          </section>
        );
      })}
    </>
  );
}

/** The header controls plugins add for a Component type (ADR 0142: the Physics plugin's Edit Collider). */
function headerActionsFor(type: string): ComponentHeaderActionContribution[] {
  componentHeaderActions.version.value;
  return componentHeaderActions.list().filter((a) => (a.types instanceof Set ? a.types.has(type) : (a.types as readonly string[]).includes(type)));
}

/** Where a dragged component would land: next to the component `type`#`index`, before or after it. */
const componentDrop = signal<{ type: string; index: number; after: boolean } | null>(null);

/**
 * Drag a component by its grip to reorder it among the node's scripts and engine components
 * (data components and Transform stay put). A line shows where it will land.
 */
function startReorder(e: PointerEvent, scene: OpenScene, path: NodePath, info: ComponentInfo, siblings: readonly ComponentInfo[]): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  const self = grip.closest(".component");
  const move = (m: PointerEvent) => {
    const cards = [...document.querySelectorAll<HTMLElement>(".inspector-body .component[data-reorder]")];
    let best: { card: HTMLElement; after: boolean; distance: number } | null = null;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const distance = m.clientY < r.top ? r.top - m.clientY : m.clientY > r.bottom ? m.clientY - r.bottom : 0;
      if (!best || distance < best.distance) best = { card, after: m.clientY > r.top + r.height / 2, distance };
    }
    componentDrop.value = best && best.card !== self ? { type: best.card.dataset.type!, index: Number(best.card.dataset.index), after: best.after } : null;
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    const drop = componentDrop.value;
    componentDrop.value = null;
    const anchor = drop && siblings.find((c) => c.type === drop.type && c.index === drop.index);
    const node = scene.sync.nodeFor(path);
    if (anchor && node) moveComponent(scene, path, node, info, anchor, drop.after);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

/**
 * One component, shared by every node in `paths` (`infos` holds each node's copy, in the same
 * order). `siblings` (a single node's whole list) makes it reorderable.
 */
function ComponentCard(props: { scene: OpenScene; paths: NodePath[]; infos: ComponentInfo[]; siblings?: readonly ComponentInfo[] }) {
  const { paths, infos } = props;
  const info = infos[infos.length - 1];
  const title = info.type.replace(/^(engine|game|editor)\./, "");
  const actions = headerActionsFor(info.type);
  // Remove: from every node that allows it; disabled (with the first reason) when none does.
  const { scene } = props;
  const checks = paths.map((path, i) => {
    const node = scene.sync.nodeFor(path);
    if (!node) return { reason: "that node is gone" };
    const count = listComponents(node).filter((c) => c.type === infos[i].type).length;
    return { reason: whyNotRemovable(scene.doc, path, infos[i], count), target: { path, node, info: infos[i] } };
  });
  const removable = checks.flatMap((c) => (c.reason === null && c.target ? [c.target] : []));
  const notRemovable = removable.length === 0 ? checks[0].reason : null;
  // The project script that defines this component, if any (ADR 0030).
  scriptsVersion.value;
  const script = currentProject.value ? scriptFor(currentProject.value.scripts, info.type) : null;
  // Enabled: a checkbox across every node; mixed shows as indeterminate.
  const toggleable = checks.flatMap((c) =>
    c.target && whyNotToggleable(scene.doc, c.target.path, c.target.info, listComponents(c.target.node).filter((o) => o.type === info.type).length) === null ? [c.target] : [],
  );
  const allEnabled = infos.every((i) => i.enabled);
  // Reorder: a single node's components, among those that can move.
  const siblings = props.siblings?.filter((c) => whyNotReorderable(scene.doc, paths[0], c) === null) ?? [];
  const reorderable = paths.length === 1 && siblings.length > 1 && whyNotReorderable(scene.doc, paths[0], info) === null;
  const drop = componentDrop.value;
  const dropHere = drop && drop.type === info.type && drop.index === info.index ? (drop.after ? " drop-after" : " drop-before") : "";
  const step = (by: -1 | 1) => {
    const at = siblings.findIndex((c) => c.type === info.type && c.index === info.index);
    const anchor = siblings[at + by];
    const node = scene.sync.nodeFor(paths[0]);
    if (anchor && node) moveComponent(scene, paths[0], node, info, anchor, by > 0);
  };
  // Worlds (ADR 0033 §3): which World tags each node's copy is created in.
  const worlds = checks.flatMap((c) => {
    const setting = c.target ? worldsSettingOf(scene.doc, c.target) : null;
    return setting ? [{ target: c.target!, setting }] : [];
  });
  const badges = new Set(worlds.map((w) => worldsBadge(effectiveWorlds(w.setting))));
  const badge = badges.size > 1 ? MIXED : [...badges][0] ?? null;
  return (
    <section class={`component${dropHere}${allEnabled ? "" : " off"}`} {...(reorderable ? { "data-reorder": "", "data-type": info.type, "data-index": String(info.index) } : {})}>
      <h3>
        {reorderable && (
          <button
            class="reorder-grip"
            aria-label={`Reorder ${title}`}
            title="Drag to reorder (or focus and press Alt+↑ / Alt+↓)"
            onPointerDown={(e) => startReorder(e, scene, paths[0], info, siblings)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              step(e.key === "ArrowUp" ? -1 : 1);
            }}
          >
            ⠿
          </button>
        )}
        <input
          type="checkbox"
          checked={allEnabled}
          indeterminate={!allEnabled && infos.some((i) => i.enabled)}
          disabled={toggleable.length === 0}
          aria-label={`${title} enabled`}
          title={toggleable.length === 0 ? (info.kind === "behavior" ? undefined : `${title} is always on`) : allEnabled ? `Disable ${title}` : `Enable ${title}`}
          onChange={(e) => setComponentEnabled(scene, toggleable, (e.currentTarget as HTMLInputElement).checked)}
        />
        {title}
        {info.kind === "data" && <span class="badge">data</span>}
        {badge && (
          <span class="badge worlds-badge" title={badge === MIXED ? "The selected nodes differ in which Worlds have this component" : `Created only in Worlds tagged ${badge}`}>
            {badge}
          </span>
        )}
        {script && (
          <button class="open-script" title={`Open ${script} in the Code panel`} aria-label={`Open ${title} script`} onClick={() => openScript(script)}>
            {"{ }"}
          </button>
        )}
        {actions.map((a) => (
          <a.view key={a.id} scene={scene} paths={paths} info={info} />
        ))}
        {worlds.length > 0 && <ComponentMenu scene={scene} title={title} worlds={worlds} />}
        {info.type !== "engine.Transform" && (
          <button
            class="remove-component"
            aria-label={`Remove ${title}`}
            title={notRemovable ? `Can't remove: ${notRemovable}` : paths.length > 1 ? `Remove ${title} from ${removable.length} nodes` : `Remove ${title}`}
            disabled={removable.length === 0}
            onClick={() => {
              for (const a of actions) a.onRemove?.({ scene, paths, info });
              removeComponentFrom(scene, removable);
            }}
          >
            ✕
          </button>
        )}
      </h3>
      {info.fields.length === 0 ? (
        <p class="empty">No fields</p>
      ) : (
        // Fields another editor owns (a ParticleSystem's effect, a Tilemap's layers) are hidden (ADR 0131).
        <FieldRows target={documentFieldTarget(scene, paths, infos)} fields={info.fields.filter((f) => !isHiddenField(f))} />
      )}
      {/* Per-type extras under the fields: effect editor, bake buttons, nav notes… (ADR 0131). */}
      <InspectorSections scene={scene} paths={paths} info={info} />
    </section>
  );
}

/**
 * The menu on a component's header: which Worlds it's created in (ADR 0033 §3). "Every World",
 * or only Worlds with the ticked tags; "Use default" goes back to the prefab's or the
 * component's own setting. On plain nodes this writes the component entry's `worlds`; on prefab
 * instances, an override. With several nodes selected, a change applies to each.
 */
function ComponentMenu(props: { scene: OpenScene; title: string; worlds: { target: WorldsTarget; setting: WorldsSetting }[] }) {
  const { scene, title, worlds } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [open]);
  const active = worlds[worlds.length - 1].setting;
  const current = effectiveWorlds(active);
  const all = worlds.map((w) => effectiveWorlds(w.setting));
  const tags = knownWorldTags(currentProject.value?.settings, all.flatMap((w) => w ?? []));
  const targets = worlds.map((w) => w.target);
  const anyOwn = worlds.some((w) => w.setting.own !== undefined);
  const set = (next: readonly string[]) => setWorldsFor(scene, targets, next, `Set Worlds of ${title}`);
  const toggle = (tag: string, on: boolean) => {
    const base = isEveryWorld(current) ? [] : current!.filter((t) => t !== tag);
    set(on ? [...base, tag] : base);
  };
  const everyAll = all.every(isEveryWorld);
  const everySome = all.some(isEveryWorld);
  const describe = (w: readonly string[] | undefined) => (isEveryWorld(w) ? "every World" : w!.length === 0 ? "no Worlds" : w!.join(", "));
  return (
    <span class="component-menu-wrap" ref={ref}>
      <button
        class={`component-menu-button${open ? " active" : ""}`}
        aria-label={`${title} options`}
        aria-haspopup="true"
        aria-expanded={open}
        title="More: which Worlds have this component"
        onClick={() => setOpen(!open)}
      >
      </button>
      {open && (
        <div class="component-menu" role="dialog" aria-label={`Worlds for ${title}`}>
          <div class="menu-heading">Worlds</div>
          <p class="menu-note">Create {title} only in Worlds with these tags. Editor Worlds always have it.</p>
          <label class="menu-check">
            <input
              type="checkbox"
              checked={everyAll}
              indeterminate={!everyAll && everySome}
              onChange={(e) => set((e.currentTarget as HTMLInputElement).checked ? ["*"] : [])}
            />
            Every World
          </label>
          {tags.map((tag) => {
            const has = all.map((w) => !isEveryWorld(w) && w!.includes(tag));
            return (
              <label key={tag} class="menu-check tag">
                <input
                  type="checkbox"
                  aria-label={`World tag ${tag}`}
                  checked={has.every(Boolean)}
                  indeterminate={!has.every(Boolean) && has.some(Boolean)}
                  onChange={(e) => toggle(tag, (e.currentTarget as HTMLInputElement).checked)}
                />
                {tag}
              </label>
            );
          })}
          <input
            type="text"
            class="menu-add-tag"
            aria-label="Add a World tag"
            placeholder="Other tag…"
            value={draft}
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const tag = cleanTag(draft);
              if (tag && tag !== "*") toggle(tag, true);
              setDraft("");
            }}
          />
          <button
            class="menu-reset"
            disabled={!anyOwn}
            title={anyOwn ? "Remove the setting made here" : "Nothing is set here"}
            onClick={() => setComponentWorlds(scene, targets, undefined)}
          >
            Use default ({describe(active.inherited)})
          </button>
        </div>
      )}
    </span>
  );
}

/**
 * A node's tags (ADR 0042) as chips: ✕ removes one, typing in the box and pressing Enter adds
 * one. With several nodes, tags only some have are dimmed; adding or removing acts on all. On a
 * prefab instance (or a node inside one) the tags are an override, which ↺ reverts.
 */
function NodeTags(props: { scene: OpenScene; paths: NodePath[] }) {
  const { scene, paths } = props;
  const [draft, setDraft] = useState("");
  const lists = paths.map((p) => scene.sync.nodeFor(p)?.tags ?? []);
  const union = [...new Set(lists.flat())];
  const overridden = paths.some((p) => tagsOverridden(scene.doc, p));
  const add = () => {
    const tag = cleanTag(draft);
    setDraft("");
    if (tag) setNodeTags(scene, paths, (cur) => (cur.includes(tag) ? cur : [...cur, tag]), `Add tag ${tag}`);
  };
  return (
    <div class={`node-tags${overridden ? " overridden" : ""}`} role="group" aria-label="Tags">
      <span class="node-tags-label">Tags</span>
      {union.map((tag) => {
        const partial = !lists.every((l) => l.includes(tag));
        return (
          <span key={tag} class={`tag-chip${partial ? " partial" : ""}`} title={partial ? "Only some of the selected nodes have this tag" : undefined}>
            <span class="tag-name">{tag}</span>
            <button aria-label={`Remove tag ${tag}`} title={`Remove ${tag}`} onClick={() => setNodeTags(scene, paths, (cur) => cur.filter((t) => t !== tag), `Remove tag ${tag}`)}>
              ✕
            </button>
          </span>
        );
      })}
      <input
        type="text"
        class="tag-input"
        aria-label="Add tag"
        placeholder={union.length === 0 ? "Add a tag…" : "+ tag"}
        value={draft}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") setDraft("");
        }}
        onBlur={add}
      />
      {overridden && (
        <button class="revert" aria-label="Revert tags" title="Tags overridden in this scene. Revert to the prefab's tags" onClick={() => setNodeTags(scene, paths.filter((p) => tagsOverridden(scene.doc, p)), () => undefined, "Revert tags")}>
          ↺
        </button>
      )}
    </div>
  );
}
