import { errorStatus } from "../messages";
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Color, GameObject, Quaternion } from "../../engine";
import type { FieldChoice } from "../../engine/core/registry";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { RevertOverrides, pathKey, type NodePath } from "../document";
import { choicesFor, defaultItem, editorFor, fieldTitle, itemEditorFor, itemField, type FieldEditor } from "../fieldValues";
import { fieldState, revertField, rotationViewOf, setField, setFieldAxis, setFieldEach, withAxis } from "../fieldEdits";
import { MIXED, NumberInput, formatNumber } from "../fields/NumberInput";
import { RotationField } from "../fields/RotationField";
import { fieldChoicesFor, listedChoices, loadFieldChoices } from "../fieldChoices";
import type { FieldChoicesContribution } from "../sdk/contributions";
import {
  cleanTag,
  componentWorlds,
  effectiveWorlds,
  isEveryWorld,
  knownWorldTags,
  setComponentWorlds,
  setNodeTags,
  tagsOverridden,
  worldsBadge,
  type WorldsSetting,
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
import { openPrefabFrom } from "../prefabTabs";
import { AddComponentMenu } from "./AddComponentMenu";
import { AssetInspector } from "./AssetInspector";
import { showsAssetInspector } from "../assetImport";
import { listedFiles } from "../assetBrowser";
import { assetKindsOf, assetListId, assetsForKinds, isHiddenField } from "../assetFieldKinds";
import { ASSET_FIELD_KINDS, AssetRef, getComponentClass, getFields, isListType, listComponentIds, type AssetFieldKind } from "../../engine/core/registry";
import { InspectorSections } from "./inspectorSections";
import "./inspectorSections.builtin";
import { liveInspecting } from "../runtimeInspect";
import { addToPreload, preloadCandidates, removeFromPreload } from "../scenePreload";
import { RuntimeInspector } from "./RuntimeInspector";
import { UIElementInspector } from "./UIElementInspector";
import { openScript, scriptFor } from "../code/codeState";
import { applyOverrides, applyOverridesTo, createPrefabFromNodes, createPrefab, findInner, isInnerPropertyOverridden, nodePropertyCommand, revertInnerProperty } from "../prefabs";
import { currentProject, docVersion, openScene, scriptsVersion, selectedKeys, selectedUIElement, selection, status, type OpenScene } from "../state";
import { componentHeaderActions, type ComponentHeaderActionContribution } from "../sdk/contributions";
import { isKeyboardEvent, ownerDocumentOf } from "../windows/dom";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
              inGroup(scene, "Revert name and active", () => {
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
            inGroup(scene, `${on ? "Activate" : "Deactivate"} ${paths.length} nodes`, () => {
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

/** Run `body` as one undo step. */
function inGroup(scene: OpenScene, label: string, body: () => void): void {
  scene.stack.beginGroup(label);
  try {
    body();
  } finally {
    scene.stack.endGroup();
  }
}

/** Apply or revert all of an instance's overrides. */
function PrefabActions(props: { scene: OpenScene; id: string }) {
  docVersion.value; // its props don't change when overrides do, so read the document version
  const { scene, id } = props;
  const project = currentProject.value;
  const count = scene.doc.node(id).overrides?.length ?? 0;
  const canApply = count > 0 && !!project?.canSave;
  const applyTitle = !project?.canSave
    ? "This project is read-only. Open a project folder to apply overrides."
    : "Write this instance's overrides into the prefab file (updates every instance)";
  return (
    <div class="prefab-actions">
      <span class="override-count">{count === 0 ? "No overrides" : `${count} override${count === 1 ? "" : "s"}`}</span>
      <button
        disabled={!canApply}
        title={applyTitle}
        onClick={async () => {
          try {
            const n = await applyOverrides(scene, project!, id);
            const prefab = scene.doc.node(id).prefab;
            status.value = { kind: "info", text: `Applied ${n} override${n === 1 ? "" : "s"} to ${prefab}. Undo restores them here; the prefab file keeps the change.` };
          } catch (err) {
            status.value = errorStatus(null, err);
          }
        }}
      >
        Apply
      </button>
      <button
        disabled={count === 0}
        title="Remove all overrides: back to the prefab's values"
        onClick={() => scene.stack.execute(new RevertOverrides(id, "Revert all overrides"))}
      >
        Revert All
      </button>
      <OpenPrefabButton path={[id]} />
    </div>
  );
}

/** Open the prefab file in its own tab, with this node selected there (ADR 0122). */
function OpenPrefabButton(props: { path: NodePath }) {
  return (
    <button title="Edit the prefab itself in its own tab (Back returns here)" onClick={() => void openPrefabFrom(props.path)}>
      Open Prefab
    </button>
  );
}

/** Create Prefab for several sibling nodes, and Apply for several instances (ADR 0087). */
function MultiPrefabActions(props: { scene: OpenScene; paths: NodePath[] }) {
  docVersion.value;
  const { scene, paths } = props;
  const project = currentProject.value;
  if (paths.some((p) => p.length > 1)) return null;
  const ids = paths.map((p) => p[0]);
  const plain = ids.filter((id) => !scene.doc.node(id).prefab);
  const withOverrides = ids.filter((id) => scene.doc.node(id).prefab && (scene.doc.node(id).overrides?.length ?? 0) > 0);
  const canSave = !!project?.canSave;
  return (
    <div class="prefab-actions">
      {plain.length === ids.length && (
        <button
          disabled={!canSave}
          title={canSave ? "Save these nodes as one prefab (under a new Group root) and replace them with an instance" : "This project is read-only. Open a project folder to create prefabs."}
          onClick={async () => {
            try {
              const path = await createPrefabFromNodes(scene, project!, ids);
              status.value = { kind: "info", text: `Created ${path}. Undo turns the nodes back; the file stays on disk.` };
            } catch (err) {
              status.value = errorStatus(null, err);
            }
          }}
        >
          Create Prefab
        </button>
      )}
      {withOverrides.length > 0 && (
        <button
          disabled={!canSave}
          title="Write the selected instances' overrides into their prefab files"
          onClick={async () => {
            try {
              const n = await applyOverridesTo(scene, project!, withOverrides);
              status.value = { kind: "info", text: `Applied ${n} override${n === 1 ? "" : "s"} from ${withOverrides.length} instances.` };
            } catch (err) {
              status.value = errorStatus(null, err);
            }
          }}
        >
          Apply
        </button>
      )}
    </div>
  );
}

function CreatePrefabButton(props: { scene: OpenScene; id: string }) {
  docVersion.value;
  const { scene, id } = props;
  const project = currentProject.value;
  const title = project?.canSave
    ? "Save this node and its children as a prefab file, and make this node an instance of it"
    : "This project is read-only. Open a project folder to create prefabs.";
  return (
    <div class="prefab-actions">
      <button
        disabled={!project?.canSave}
        title={title}
        onClick={async () => {
          try {
            const path = await createPrefab(scene, project!, id);
            selection.value = id;
            status.value = { kind: "info", text: `Created ${path}. Undo turns the node back; the file stays on disk.` };
          } catch (err) {
            status.value = errorStatus(null, err);
          }
        }}
      >
        Create Prefab
      </button>
    </div>
  );
}

/** The header controls plugins add for a Component type (ADR 0142: the Physics plugin's Edit Collider). */
function headerActionsFor(type: string): ComponentHeaderActionContribution[] {
  componentHeaderActions.version.value;
  return componentHeaderActions.list().filter((a) => (a.types instanceof Set ? a.types.has(type) : (a.types as readonly string[]).includes(type)));
}

/** One component, shared by every node in `paths` (`infos` holds each node's copy, in the same order). */
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
    // This Inspector's cards (its own document, its own body: there may be more than one, ADR 0174).
    const cards = [...(grip.closest(".inspector-body") ?? grip.ownerDocument).querySelectorAll<HTMLElement>(".inspector-body .component[data-reorder]")];
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
    if (!c.target) return [];
    const setting = componentWorlds(scene.doc, c.target.path, c.target.info, listComponents(c.target.node).filter((o) => o.type === info.type).length);
    return setting ? [{ target: c.target, setting }] : [];
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
        <div class="fields">
          {info.fields
            // Fields another editor owns (a ParticleSystem's effect, a Tilemap's layers) are hidden (ADR 0131).
            .filter((f) => !isHiddenField(f))
            .map((f) => (
              <FieldRow key={f.name} {...props} info={info} values={infos.map((i) => i.fields.find((o) => o.name === f.name)?.value)} field={f} />
            ))}
        </div>
      )}
      {/* Per-type extras under the fields: effect editor, bake buttons, nav notes… (ADR 0131). */}
      <InspectorSections scene={scene} paths={paths} info={info} />
    </section>
  );
}

/**
 * One field of a component on every node in `paths`; `values` holds each node's value. Values
 * that differ show as mixed, and a commit writes every node (one undo step for several).
 */
function FieldRow(props: { scene: OpenScene; paths: NodePath[]; info: ComponentInfo; field: FieldValue; values: unknown[] }) {
  const { scene, paths, info, field, values } = props;
  const editor = editorFor(field);
  const { mixed, overridden } = fieldState(scene, paths, info, field.name, values);
  // Choices a plugin supplies for this field (ADR 0152), e.g. a MeshRenderer's material variants.
  const contributed = fieldChoicesFor(info.type, field.name);
  const loaded = useContributedChoices(contributed, info);
  const choices = contributed ? listedChoices(contributed, loaded, field.value, mixed) : undefined;

  const commit = (value: unknown) => setField(scene, paths, info, field, value);
  const commitAxis = (axis: number, n: number) => setFieldAxis(scene, paths, info, field, axis, n, values);
  const commitEach = (next: readonly unknown[]) => setFieldEach(scene, paths, info, field, (i) => next[i]);
  const revert = () => revertField(scene, paths, info, field.name);

  if (choices === null) return null; // nothing to choose and nothing set
  return (
    <>
      <div class={`label-cell${overridden ? " overridden" : ""}`}>
        <ScrubLabel name={field.name} title={fieldTitle(field)} scene={scene} value={isNumeric(editor) && !mixed ? Number(field.value) : null} onScrub={commit} />
        {overridden && (
          <button class="revert" title={`Overridden in this scene. Revert ${field.name} to the prefab's value`} aria-label={`Revert ${field.name}`} onClick={revert}>
            ↺
          </button>
        )}
      </div>
      <div class="value">
        {choices !== undefined ? (
          <ChoiceInput choices={choices} value={field.value} mixed={mixed} label={field.name} onCommit={commit} />
        ) : (
          <FieldEditorView
            editor={editor}
            field={field}
            values={values}
            mixed={mixed}
            scene={scene}
            rowKey={`${info.type}.${field.name}`}
            onCommit={commit}
            onCommitAxis={commitAxis}
            onCommitEach={commitEach}
          />
        )}
      </div>
    </>
  );
}

/** A contributed field's loaded choices (ADR 0152), asked for again when what they depend on changes; empty until they load. */
function useContributedChoices(contribution: FieldChoicesContribution | undefined, info: ComponentInfo): readonly FieldChoice[] {
  const [loaded, setLoaded] = useState<readonly FieldChoice[]>([]);
  const key = contribution ? `${contribution.id}\u0000${contribution.key(info)}` : null;
  useEffect(() => {
    setLoaded([]);
    if (!contribution) return;
    let live = true;
    void loadFieldChoices(contribution, info).then((choices) => live && setLoaded(choices));
    return () => {
      live = false;
    };
  }, [key]); // `key` names everything the choices depend on
  return loaded;
}

const isNumeric = (e: FieldEditor) => e === "number" || e === "integer";

function FieldEditorView(props: {
  editor: FieldEditor;
  field: FieldValue;
  /** Each selected node's value; `field.value` is the active node's. */
  values: unknown[];
  mixed: boolean;
  scene: OpenScene;
  /** Names the row for per-row view choices (a rotation's toggle). */
  rowKey?: string;
  onCommit: (value: unknown) => void;
  onCommitAxis: (axis: number, value: number) => void;
  /** Each node's new value, in `values` order. */
  onCommitEach: (next: readonly unknown[]) => void;
}) {
  const { editor, field, values, mixed, scene, onCommit } = props;
  const v = field.value;
  switch (editor) {
    case "number":
    case "integer":
      return <NumberInput value={mixed ? null : Number(v)} integer={editor === "integer"} label={field.name} onCommit={onCommit} />;
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={!mixed && Boolean(v)}
          indeterminate={mixed}
          aria-label={field.name}
          onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)}
        />
      );
    case "string":
      return <TextInput value={mixed ? "" : String(v ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} onCommit={onCommit} />;
    case "asset":
      return <TextInput value={mixed ? "" : String(v ?? "")} placeholder={mixed ? MIXED : undefined} label={field.name} list={assetListId(assetKindsOf(field))} onCommit={onCommit} />;
    case "color":
      return <ColorInput value={v instanceof Color ? v : Color.white} mixed={mixed} label={field.name} onCommit={onCommit} />;
    case "vector2":
    case "vector3":
      if (values.some((x) => x !== null && x !== undefined) && values.some((x) => x === null || x === undefined)) {
        // Set on some nodes, unset (automatic) on others.
        return <span class="none">{MIXED} (some Auto)</span>;
      }
      if (v === null || v === undefined) {
        // Unset (e.g. a sprite's size, which then comes from its texture): offer to set one.
        const zero = editor === "vector2" ? [1, 1] : [0, 0, 0];
        return (
          <span class="unset">
            <span class="none">Auto</span>
            <button title={`Set ${field.name} explicitly`} onClick={() => onCommit(zero)}>
              Set
            </button>
          </span>
        );
      }
      return <VectorInput value={axesOf(values)} label={field.name} onCommitAxis={props.onCommitAxis} />;
    case "node":
      return <NodeRefInput value={v instanceof GameObject ? scene.sync.nodeIdOf(v) : null} mixed={mixed} scene={scene} label={field.name} onCommit={onCommit} />;
    case "object":
      return mixed ? <span class="none">{MIXED} (differs)</span> : <ObjectInput value={(v ?? {}) as Record<string, unknown>} onCommit={onCommit} />;
    case "choice":
      return <ChoiceInput choices={choicesFor(field, currentProject.value?.settings) ?? []} value={v} mixed={mixed} label={field.name} onCommit={onCommit} />;
    case "quaternion":
      // A codec component (ADR 0165): Euler radians or degrees, or x, y, z, w, as the field or Settings say.
      if (v === null || v === undefined) return <span class="none">None</span>;
      return (
        <RotationField
          values={values.map((x) => (x instanceof Quaternion ? x : null))}
          view={rotationViewOf(field)}
          label={field.name}
          toggleKey={props.rowKey}
          onCommit={props.onCommitEach}
        />
      );
    case "list":
      return <ListInput field={field} mixed={mixed} scene={scene} rowKey={props.rowKey} onCommit={onCommit} />;
    default:
      return <span>{JSON.stringify(v)}</span>;
  }
}

// --- inputs -------------------------------------------------------------------------------------

/** Each axis shared by every vector in `values`, or null where they differ. */
function axesOf(values: unknown[]): (number | null)[] {
  const arrays = values.map((x) => (x as { toArray(): number[] }).toArray());
  return arrays[0].map((n, i) => (arrays.every((a) => a[i] === n) ? n : null));
}

/** Text that commits on Enter or blur and reverts on Escape. */
/**
 * The asset suggestions asset fields offer as you type (ADR 0043, 0044): one `<datalist>` per asset
 * kind a field can declare (ADR 0131), one per combination of kinds a registered component declares,
 * and every file for fields that declare none.
 */
function AssetLists() {
  const version = docVersion.value; // files come and go
  const scripts = scriptsVersion.value; // script components come and go
  const project = currentProject.value;
  // Built when the project's files change, not on every Inspector render.
  return useMemo(() => {
    const files = listedFiles(project?.files ?? []);
    const options = (list: readonly string[]) => list.map((f) => <option key={f} value={f} />);
    const lists = new Map<string, readonly AssetFieldKind[]>(ASSET_FIELD_KINDS.map((k) => [assetListId([k]), [k]]));
    for (const kinds of declaredKindCombinations()) lists.set(assetListId(kinds), kinds);
    return (
      <>
        {[...lists].map(([id, kinds]) => (
          <datalist key={id} id={id}>
            {options(assetsForKinds(kinds, files))}
          </datalist>
        ))}
        <datalist id="asset-list-all">{options(files)}</datalist>
      </>
    );
  }, [project, version, scripts, project?.files]);
}

/** Each combination of several asset kinds a registered component's field declares (`{ kind: ["texture", "rendertexture"] }`), and each kind outside the engine's own (a plugin's, ADR 0143). */
function declaredKindCombinations(): AssetFieldKind[][] {
  const combos: AssetFieldKind[][] = [];
  for (const id of listComponentIds()) {
    const cls = getComponentClass(id);
    if (!cls) continue;
    for (const f of getFields(cls)) {
      const item = isListType(f.type) ? f.type[0] : f.type;
      if (item !== AssetRef) continue;
      const kinds = assetKindsOf({ name: f.name, type: f.type, value: undefined, options: f.options });
      if (kinds.length > 1 || (kinds.length === 1 && !(ASSET_FIELD_KINDS as readonly string[]).includes(kinds[0]))) combos.push(kinds);
    }
  }
  return combos;
}

function TextInput(props: { value: string; label: string; class?: string; placeholder?: string; list?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useLayoutEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      list={props.list}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(props.value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A vector edited per axis; a null axis differs between the selected nodes. */
function VectorInput(props: { value: (number | null)[]; label: string; onCommitAxis: (axis: number, v: number) => void }) {
  const axes = ["x", "y", "z", "w"];
  return (
    <span class="vec">
      {props.value.map((x, i) => (
        <label key={i} class="axis">
          <em>{axes[i]}</em>
          <NumberInput value={x} label={`${props.label} ${axes[i]}`} onCommit={(n) => props.onCommitAxis(i, n)} />
        </label>
      ))}
    </span>
  );
}

function ColorInput(props: { value: Color; mixed?: boolean; label: string; onCommit: (v: Color) => void }) {
  const c = props.value;
  return (
    <span class="color">
      <input
        type="color"
        aria-label={props.label}
        value={c.toHex()}
        onChange={(e) => {
          const next = Color.from((e.currentTarget as HTMLInputElement).value);
          next.a = c.a;
          props.onCommit(next);
        }}
      />
      <span class="hex">{props.mixed ? MIXED : c.toHex()}</span>
      {!props.mixed && c.a < 1 && <span class="alpha">α {formatNumber(c.a)}</span>}
    </span>
  );
}

/** Pick another node of the open scene, or None. */
function NodeRefInput(props: { value: string | null; mixed?: boolean; scene: OpenScene; label: string; onCommit: (id: string | null) => void }) {
  const { doc } = props.scene;
  const MIXED_VALUE = "\u0000mixed";
  return (
    <select
      aria-label={props.label}
      value={props.mixed ? MIXED_VALUE : (props.value ?? "")}
      onChange={(e) => {
        const id = (e.currentTarget as HTMLSelectElement).value;
        if (id !== MIXED_VALUE) props.onCommit(id === "" ? null : id);
      }}
    >
      {props.mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      <option value="">None</option>
      {doc.nodes.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name ?? n.id}
        </option>
      ))}
    </select>
  );
}

/** A plain settings object: each key edited in place; the whole object is written back. */
function ObjectInput(props: { value: Record<string, unknown>; onCommit: (v: Record<string, unknown>) => void }) {
  const set = (key: string, next: unknown) => props.onCommit({ ...structuredClone(props.value), [key]: next });
  return (
    <div class="nested">
      {Object.entries(props.value).map(([key, v]) => (
        <div key={key} class="nested-row">
          <span class="nested-key">{humanize(key)}</span>
          {typeof v === "number" ? (
            <NumberInput value={v} label={key} onCommit={(n) => set(key, n)} />
          ) : typeof v === "boolean" ? (
            <input type="checkbox" checked={v} aria-label={key} onChange={(e) => set(key, (e.currentTarget as HTMLInputElement).checked)} />
          ) : typeof v === "string" ? (
            <TextInput value={v} label={key} onCommit={(s) => set(key, s)} />
          ) : v && typeof v === "object" && !Array.isArray(v) ? (
            <ObjectInput value={v as Record<string, unknown>} onCommit={(o) => set(key, o)} />
          ) : (
            <span>{JSON.stringify(v)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A dropdown of a field's declared choices (ADR 0042). A value that isn't one of them (set by
 * hand in the file, or a layer that was renamed) shows as such until another is picked.
 */
function ChoiceInput(props: { choices: readonly FieldChoice[]; value: unknown; mixed?: boolean; label: string; onCommit: (v: string | number) => void }) {
  const { choices, value, mixed } = props;
  const at = choices.findIndex((c) => c.value === value);
  const MIXED_VALUE = "\u0000mixed";
  const OTHER = "\u0000other";
  return (
    <select
      class="choice-input"
      aria-label={props.label}
      value={mixed ? MIXED_VALUE : at >= 0 ? String(at) : OTHER}
      onChange={(e) => {
        const picked = (e.currentTarget as HTMLSelectElement).value;
        const choice = choices[Number(picked)];
        if (picked !== MIXED_VALUE && picked !== OTHER && choice) props.onCommit(choice.value);
      }}
    >
      {mixed && (
        <option value={MIXED_VALUE} disabled>
          {MIXED}
        </option>
      )}
      {!mixed && at < 0 && (
        <option value={OTHER} disabled>
          {value === undefined || value === null || value === "" ? "(none)" : `${String(value)} (not a choice)`}
        </option>
      )}
      {choices.map((c, i) => (
        <option key={i} value={String(i)}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A list field (ADR 0042): each item with the editor for its type, moved up or down or removed,
 * and an Add button that repeats the last item (or adds a blank one). The whole list is written
 * on every change, so on a prefab instance one override replaces the prefab's list. With several
 * nodes whose lists differ it shows the active node's list under a dash; an edit replaces every
 * node's list with the edited one.
 */
function ListInput(props: { field: FieldValue; mixed: boolean; scene: OpenScene; rowKey?: string; onCommit: (items: unknown[]) => void }) {
  const { field, mixed, scene } = props;
  const items = Array.isArray(field.value) ? (field.value as unknown[]) : [];
  const editor = itemEditorFor(field);
  const choices = editor === "choice" ? choicesFor(field, currentProject.value?.settings) : null;
  const name = humanize(field.name);
  const write = (next: unknown[]) => props.onCommit(next);
  const replace = (i: number, v: unknown) => write(items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    write(next);
  };
  const add = () => {
    const last = items[items.length - 1];
    const copy = items.length === 0 ? defaultItem(editor, choices) : copyItem(last);
    write([...items, copy]);
  };
  return (
    <div class="list-field" role="group" aria-label={`${name} list`}>
      <div class="list-head">
        <span class="list-count">
          {mixed ? `${MIXED} lists differ; edits replace every list` : `${items.length} item${items.length === 1 ? "" : "s"}`}
        </span>
        <button class="list-add" aria-label={`Add ${field.name} item`} title={`Add an item to ${name}`} onClick={add}>
          + Add
        </button>
      </div>
      {items.map((item, i) => {
        const f = itemField(field, i, item);
        return (
          <div key={i} class="list-item">
            <span class="list-index">{i}</span>
            <div class="list-value">
              <FieldEditorView
                editor={editor}
                field={f}
                values={[item]}
                mixed={false}
                scene={scene}
                rowKey={props.rowKey === undefined ? undefined : `${props.rowKey}[${i}]`}
                onCommit={(v) => replace(i, v)}
                onCommitAxis={(axis, n) => replace(i, withAxis(item, editor, axis, n))}
                onCommitEach={(next) => replace(i, next[0])}
              />
            </div>
            <span class="list-buttons">
              <button aria-label={`Move ${field.name} item ${i} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button aria-label={`Move ${field.name} item ${i} down`} title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button class="list-remove" aria-label={`Remove ${field.name} item ${i}`} title="Remove this item" onClick={() => write(items.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A copy of a list item, for Add (vectors and colors are live objects; nodes are shared references). */
function copyItem(item: unknown): unknown {
  if (item instanceof GameObject || item === null || typeof item !== "object") return item;
  if (item instanceof Quaternion) return item.clone();
  if (item instanceof Color) return item.clone();
  if ("toArray" in item) return (item as { toArray(): number[] }).toArray();
  return structuredClone(item);
}

/**
 * The menu on a component's header: which Worlds it's created in (ADR 0033 §3). "Every World",
 * or only Worlds with the ticked tags; "Use default" goes back to the prefab's or the
 * component's own setting. On plain nodes this writes the component entry's `worlds`; on prefab
 * instances, an override. With several nodes selected, a change applies to each.
 */
function ComponentMenu(props: { scene: OpenScene; title: string; worlds: { target: { path: NodePath; node: GameObject; info: ComponentInfo }; setting: WorldsSetting }[] }) {
  const { scene, title, worlds } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (isKeyboardEvent(e) ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const doc = ownerDocumentOf(ref.current); // the window it's in (a detached panel window, ADR 0174)
    doc.addEventListener("pointerdown", close, true);
    doc.addEventListener("keydown", close, true);
    return () => {
      doc.removeEventListener("pointerdown", close, true);
      doc.removeEventListener("keydown", close, true);
    };
  }, [open]);
  const active = worlds[worlds.length - 1].setting;
  const current = effectiveWorlds(active);
  const all = worlds.map((w) => effectiveWorlds(w.setting));
  const tags = knownWorldTags(currentProject.value?.settings, all.flatMap((w) => w ?? []));
  const targets = worlds.map((w) => w.target);
  const anyOwn = worlds.some((w) => w.setting.own !== undefined);
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    isEveryWorld(a) === isEveryWorld(b) && (isEveryWorld(a) || (a!.length === b!.length && a!.every((t) => b!.includes(t))));
  /** Set `next` on every node; where it matches what a node inherits, drop the node's own setting instead. */
  const set = (next: readonly string[]) => {
    scene.stack.beginGroup(`Set Worlds of ${title}`);
    try {
      for (const { target, setting } of worlds) {
        if (same(next, setting.inherited)) {
          if (setting.own !== undefined) setComponentWorlds(scene, [target], undefined);
        } else if (setting.own === undefined || !same(next, setting.own)) {
          setComponentWorlds(scene, [target], next);
        }
      }
    } finally {
      scene.stack.endGroup();
    }
  };
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

/**
 * A field label. For numbers, dragging it left/right scrubs the value; the whole drag is one undo
 * step. Shift drags 10× faster, Alt 10× slower.
 */
function ScrubLabel(props: { name: string; title?: string; scene: OpenScene; value: number | null; onScrub: (value: number) => void }) {
  const drag = useRef<{ x: number; start: number; total: number } | null>(null);
  const { value, onScrub, scene } = props;
  return (
    <label
      title={props.title ?? props.name}
      class={value !== null ? "scrub" : undefined}
      onPointerDown={(e) => {
        if (value === null || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, total: 0 };
        scene.stack.beginGroup(`Drag ${props.name}`);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (dx === 0) return;
        d.x = e.clientX;
        d.total += dx * 0.05 * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        onScrub(Math.round((d.start + d.total) * 1000) / 1000);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        scene.stack.endGroup();
      }}
    >
      {humanize(props.name)}
    </label>
  );
}

/** `orderInLayer` → "Order In Layer". */
function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
