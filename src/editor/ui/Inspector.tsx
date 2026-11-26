import { Panel } from "./panel/Panel";
import { signal } from "@preact/signals";
import { useMemo, useRef, useState } from "preact/hooks";
import { GameObject } from "../../engine";
import { listComponents, type ComponentInfo } from "../../engine/editor";
import { pathKey, type NodePath } from "../document";
import { MIXED } from "../fields/NumberInput";
import {
  cleanTag,
  componentWorlds,
  effectiveWorlds,
  isEveryWorld,
  knownWorldTags,
  setComponentWorlds,
  setNodeTags,
  TAGS,
  withWorldTag,
  worldsBadge,
  type WorldsSetting,
} from "../inspectorEdits";
import "./inspector-fields.css";
import { useDraftText } from "./draftText";
import { FieldRows, TextInput } from "./fieldRows";
import { documentFieldTarget } from "../fieldTarget";
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
import { isOverridden } from "../overrideWriter";
import { AddComponentMenu } from "./AddComponentMenu";
import { AssetInspector } from "./AssetInspector";
import { inspectorTarget } from "../inspectorTarget";
import { listedFiles } from "../assetBrowser";
import { isHiddenField } from "../assetFieldKinds";
import { InspectorSections } from "./inspectorSections";
import "./inspectorSections.builtin";
import { addToPreload, preloadCandidates, removeFromPreload } from "../scenePreload";
import { RuntimeInspector } from "./RuntimeInspector";
import { UIViewElementInspector } from "./UIViewElementInspector";
import { openScript } from "../code/codeBuffers";
import { scriptFor } from "../code/codeState";
import { applyPrefabOverrides, createPrefabFrom, nodeHeader, openPrefabOf, prefabActions, renameNode, renameNodeId, revertAllOverrides, revertNameAndActive, setNodesActive } from "../nodeEdits";
import { currentProject, docVersion, scriptsVersion, status, type OpenScene } from "../state";
import { componentHeaderActions, skeletonBones, type BoneInspectorProps, type ComponentHeaderActionContribution, type SkeletonBonesContribution } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import { usePopover } from "./popover";
import { editableNow, statusSentence, whyNotEdit } from "../editGate";

/**
 * What the Inspector shows (ADR 0242, `inspectorTarget`): a live World's node while playing, an
 * asset, a UI document element, the selected nodes or the open scene's settings.
 */
export function Inspector() {
  const target = inspectorTarget.value;
  switch (target.kind) {
    case "live": return <Panel><RuntimeInspector /></Panel>; // a live World of the running game (ADR 0022, 0124)
    case "asset": return <Panel><AssetInspector path={target.path} /></Panel>; // a file selected in the Assets panel (ADR 0040, 0143)
    case "uiViewElement": return <Panel><UIViewElementInspector /></Panel>; // an element a UIView rendered (ADR 0419 wave C)
    case "bone": return <Panel><BoneInspector provider={target.provider} scene={target.scene} path={target.path} bone={target.bone} /></Panel>; // a Skeleton's bone (ADR 0373)
    case "nodes":
      return target.paths.length > 1 ? <Panel><MultiInspector scene={target.scene} paths={[...target.paths]} /></Panel> : <NodeInspector scene={target.scene} path={target.paths[0]} />;
    case "sceneSettings": return <Panel><SceneSettings scene={target.scene} /></Panel>;
    case "nothing": return <Panel><p class="empty">Nothing selected</p></Panel>;
  }
}

/** Each bone contribution's Inspector view, loaded on first use (ADR 0083). */
const boneViews = new WeakMap<SkeletonBonesContribution, LazyComponent<BoneInspectorProps>>();

/** A selected bone (ADR 0373), shown by the view of the plugin listing it; nothing once that plugin is gone. */
function BoneInspector(props: BoneInspectorProps & { provider: string }) {
  const { provider, ...rest } = props;
  const contribution = skeletonBones.get(provider);
  if (!contribution) return <p class="empty">Nothing selected</p>;
  let View = boneViews.get(contribution);
  if (!View) boneViews.set(contribution, (View = lazyComponent(contribution.inspector)));
  return <View {...rest} />;
}

/**
 * The selected node's components with their declared fields and live values (ADR 0022, 0026).
 * Every edit is a command on the open document, so it can be undone. On a prefab instance, or a
 * node inside one, edits become overrides: overridden fields are marked and can be reverted, and
 * the instance's overrides can be applied to the prefab file. With several nodes selected
 * (`MultiInspector`) it shows the components they all have; fields that differ show a dash, and
 * an edit sets every selected node in one undo step.
 */
function NodeInspector(props: { scene: OpenScene; path: NodePath }) {
  const { scene, path } = props;
  docVersion.value; // re-render when the document changes
  const paths = [path];
  const header = nodeHeader(scene, paths);
  const inner = header.inner;

  const id = path[0];
  const entry = scene.doc.node(id);
  const node = scene.sync.nodeFor(path);
  const components = node ? inFileOrder(scene.doc, id, listComponents(node)) : [];
  const key = pathKey(path);
  return (
    <Panel>
      <div class="inspector-body">
        <SceneReadOnlyNote scene={scene} />
        <div class="node-header">
          <input
            type="checkbox"
            class={header.activeOverridden ? "overridden" : undefined}
            checked={header.active === true}
            aria-label="Active"
            title={inner ? "Inside a prefab instance: switching it is an override" : undefined}
            onChange={(e) => setNodesActive(scene, paths, (e.currentTarget as HTMLInputElement).checked)}
          />
          <TextInput
            class={`node-name${inner ? " inner-name" : ""}${header.nameOverridden ? " overridden" : ""}`}
            value={header.names[0]}
            label="Name"
            onCommit={(name) => renameNode(scene, path, name)}
          />
          {(header.nameOverridden || header.activeOverridden) && (
            <button
              class="revert node-revert"
              aria-label="Revert name and active"
              title="Name or active overridden in this scene. Revert to the prefab's"
              onClick={() => revertNameAndActive(scene, paths)}
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
          <dd>{inner ? key : <NodeIdField scene={scene} id={id} />}</dd>
          {entry.prefab && (
            <>
              <dt>{inner ? "Inside" : "Prefab"}</dt>
              <dd>{entry.prefab}</dd>
            </>
          )}
        </dl>
        <NodeTags scene={scene} paths={[path]} />
        <PrefabActionsBar scene={scene} paths={paths} />
        {components.map((c) => (
          <ComponentCard key={`${key}/${c.type}#${c.index}`} scene={scene} paths={[path]} infos={[c]} siblings={components} />
        ))}
        <MissingComponents scene={scene} path={path} />
        {node && <AddComponentMenu scene={scene} targets={[{ path, node }]} />}
      </div>
    </Panel>
  );
}

/**
 * Why the scene document can't be edited now, over the Inspector's document view: during play it is
 * read-only (Unity's rule, ADR 0257), and the edit gate refuses every edit with the same words.
 */
function SceneReadOnlyNote(props: { scene: OpenScene }) {
  const reason = whyNotEdit({ kind: "scene", scene: props.scene });
  return reason ? (
    <p class="inspector-read-only" role="status">
      {statusSentence(reason)} The running game is in the live World.
    </p>
  ) : null;
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
    if (!path || !editableNow({ kind: "scene", scene })) return;
    if (list.includes(path)) status.value = { kind: "info", text: `${path} is already on the preload list.` };
    else if (!addToPreload(scene, path)) status.value = { kind: "error", text: `The preload list takes prefabs and materials (.prefab.json, .material.json), not ${path}.` };
    setDraft("");
  };
  return (
    <div class="inspector-body scene-settings">
      <SceneReadOnlyNote scene={scene} />
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
              <button class="remove-component" aria-label={`Remove ${p} from the preload list`} title="Remove" onClick={() => editableNow({ kind: "scene", scene }) && removeFromPreload(scene, p)}>
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

/** A top-level node's id, editable: commits on Enter or blur, reverts on Escape; a refused id shows why under the field. */
function NodeIdField(props: { scene: OpenScene; id: string }) {
  const { scene, id } = props;
  // The refusal belongs to the node it was made on: selecting another node (another id, or another scene) drops it.
  const [refusal, setRefusal] = useState<{ scene: OpenScene; id: string; error: string | null } | null>(null);
  const error = refusal && refusal.scene === scene && refusal.id === id ? refusal.error : null;
  const { input } = useDraftText(id, (draft) => {
    setRefusal({ scene, id, error: draft === id ? null : renameNodeId(scene, id, draft) });
  });
  return (
    <>
      <input type="text" class={`node-id${error ? " invalid" : ""}`} aria-label="Id" aria-invalid={error ? true : undefined} aria-describedby={error ? "node-id-error" : undefined} {...input} />
      {error && (
        <div id="node-id-error" class="node-id-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** Several nodes: their names, a shared active toggle, Delete, and the components they all have. */
function MultiInspector(props: { scene: OpenScene; paths: NodePath[] }) {
  const { scene, paths } = props;
  const nodes = paths.map((p) => scene.sync.nodeFor(p));
  const lists = nodes.map((n) => (n ? listComponents(n) : []));
  // Components every node has, matched by type and index, in the active (last) node's order.
  const shared = lists[lists.length - 1].filter((c) => lists.every((l) => l.some((o) => o.type === c.type && o.index === c.index)));
  const header = nodeHeader(scene, paths);
  const names = header.names;
  const anyInner = header.inner;
  const key = paths.map(pathKey).join("|");
  return (
    <div class="inspector-body">
      <SceneReadOnlyNote scene={scene} />
      <PrefabActionsBar scene={scene} paths={paths} />
      <div class="node-header">
        <input
          type="checkbox"
          checked={header.active === true}
          indeterminate={header.active === "mixed"}
          aria-label="Active"
          title={anyInner ? "Nodes inside a prefab instance are switched as overrides" : undefined}
          onChange={(e) => setNodesActive(scene, paths, (e.currentTarget as HTMLInputElement).checked)}
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
        const reason = whyNotRemovableMissing(scene.doc, path, entry.type, k);
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
                onClick={() => removeMissingComponent(scene, path, entry.type, k)}
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

/**
 * The prefab actions for the selection (ADR 0022, 0087, 0122): Create Prefab on plain nodes; on one
 * instance its override count, Apply, Revert All and Open Prefab; on a node inside an instance, Open
 * Prefab; on several instances, Apply. A disabled action's tooltip says why.
 */
function PrefabActionsBar(props: { scene: OpenScene; paths: NodePath[] }) {
  docVersion.value; // its props don't change when overrides do, so read the document version
  const { scene, paths } = props;
  const project = currentProject.value;
  const actions = prefabActions(scene, project, paths);
  const { create, apply, revertAll, open } = actions;
  if (!create && !apply && !revertAll && !open) return null;
  const several = paths.length > 1;
  const count = actions.overrides;
  return (
    <div class="prefab-actions">
      {open && !revertAll && actions.prefab && <span class="override-count">Inside {actions.prefab.split("/").pop()}</span>}
      {revertAll && <span class="override-count">{count === 0 ? "No overrides" : `${count} override${count === 1 ? "" : "s"}`}</span>}
      {create && (
        <button
          disabled={create.whyNot !== null}
          title={
            create.whyNot ??
            (several ? "Save these nodes as one prefab (under a new Group root) and replace them with an instance" : "Save this node and its children as a prefab file, and make this node an instance of it")
          }
          onClick={() => void createPrefabFrom(scene, project, paths)}
        >
          Create Prefab
        </button>
      )}
      {apply && (
        <button
          disabled={apply.whyNot !== null}
          title={apply.whyNot ?? (several ? "Write the selected instances' overrides into their prefab files" : "Write this instance's overrides into the prefab file (updates every instance)")}
          onClick={() => void applyPrefabOverrides(scene, project, paths)}
        >
          Apply
        </button>
      )}
      {revertAll && (
        <button disabled={revertAll.whyNot !== null} title={revertAll.whyNot ?? "Remove all overrides: back to the prefab's values"} onClick={() => revertAllOverrides(scene, paths)}>
          Revert All
        </button>
      )}
      {open && (
        <button title="Edit the prefab itself in its own tab (Back returns here)" onClick={() => void openPrefabOf(scene, paths)}>
          Open Prefab
        </button>
      )}
    </div>
  );
}

/** The header controls plugins add for a Component type (ADR 0142), and the Edit toggles viewport tools bring (ADR 0266). */
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
    return { reason: whyNotRemovable(scene.doc, path, infos[i]), target: { path, node, info: infos[i] } };
  });
  const removable = checks.flatMap((c) => (c.reason === null && c.target ? [c.target] : []));
  const notRemovable = removable.length === 0 ? checks[0].reason : null;
  // The project script that defines this component, if any (ADR 0030).
  scriptsVersion.value;
  const script = currentProject.value ? scriptFor(currentProject.value.scripts, info.type) : null;
  // Enabled: a checkbox across every node; mixed shows as indeterminate.
  const toggleable = checks.flatMap((c) =>
    c.target && whyNotToggleable(scene.doc, c.target.path, c.target.info) === null ? [c.target] : [],
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
    const setting = componentWorlds(scene.doc, c.target.path, c.target.info);
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
        // One row per field over the document target (ADR 0243); fields another editor owns (a ParticleSystem's effect, a Tilemap's layers) are hidden (ADR 0131).
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
function ComponentMenu(props: { scene: OpenScene; title: string; worlds: { target: { path: NodePath; node: GameObject; info: ComponentInfo }; setting: WorldsSetting }[] }) {
  const { scene, title, worlds } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  // The button and its menu, closing in the window they're in (a detached panel window, ADR 0174); CSS places the menu.
  usePopover(ref, open, { onDismiss: () => setOpen(false) });
  const active = worlds[worlds.length - 1].setting;
  const all = worlds.map((w) => effectiveWorlds(w.setting));
  const tags = knownWorldTags(currentProject.value?.settings, all.flatMap((w) => w ?? []));
  const targets = worlds.map((w) => w.target);
  const anyOwn = worlds.some((w) => w.setting.own !== undefined);
  const set = (next: readonly string[]) => setComponentWorlds(scene, targets, next, `Set Worlds of ${title}`);
  // Per node, like NodeTags: ticking a tag adds it to each node's own Worlds, unticking removes it from each.
  const toggle = (tag: string, on: boolean) => setComponentWorlds(scene, targets, (cur) => withWorldTag(cur, tag, on), `Set Worlds of ${title}`);
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
  const overridden = paths.some((p) => isOverridden(scene.doc, p, TAGS));
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
        <button class="revert" aria-label="Revert tags" title="Tags overridden in this scene. Revert to the prefab's tags" onClick={() => setNodeTags(scene, paths.filter((p) => isOverridden(scene.doc, p, TAGS)), () => undefined, "Revert tags")}>
          ↺
        </button>
      )}
    </div>
  );
}
