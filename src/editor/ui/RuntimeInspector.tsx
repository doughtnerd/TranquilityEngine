import { useEffect, useRef, useState } from "preact/hooks";
import { Color, GameObject } from "../../engine";
import { listComponents, type ComponentInfo, type FieldValue } from "../../engine/editor";
import { editorFor, parseNumber, toSceneJSON } from "../fieldValues";
import { addLiveComponent, liveNodeChoices, removeLiveComponent, setLiveNodeRef, whyNotRemoveLive } from "../liveEdits";
import { docPathFor, forgetKept, inspectedWorld, keepComponent, keepNode, kept, keptKey, liveSelection, writeLive } from "../runtimeInspect";
import { playing } from "../session";
import { openScene, status } from "../state";
import { AddComponentMenu } from "./AddComponentMenu";
import "./playdebug.css";

/** Live values refresh this often (not every frame); a field being typed in keeps its draft. */
const REFRESH_MS = 250;

/**
 * The selected node of a live World (ADR 0022): its components with live values, editable. Edits
 * change the running World only. "Keep values" remembers a component's values to write into the
 * edited scene on Stop (as overrides on prefab instances), for nodes that came from that scene.
 * Components can be added and removed and node references set (ADR 0124); those changes aren't
 * kept.
 */
export function RuntimeInspector() {
  const [, setTick] = useState(0); // also re-renders after an add or remove
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const node = liveSelection.value;
  const world = inspectedWorld.value;
  const scene = openScene.value;
  const session = playing.value;
  kept.value; // the kept marks follow it
  if (!node) return <p class="empty">Select a node of World {world} (live) in the Hierarchy.</p>;
  if (!node.isValid) return <p class="empty">That node has been destroyed.</p>;
  const mapping = scene ? docPathFor(node, scene.path, scene.doc) : { reason: "no scene is open." };
  const keepable = "path" in mapping;
  const afterEdit = () => session?.paused && session.redraw();
  const components = listComponents(node);
  const keepAll = () => {
    if (!scene) return;
    const r = keepNode(scene, node);
    status.value =
      typeof r === "string"
        ? { kind: "error", text: `Can't keep ${node.name}'s values: ${r}` }
        : { kind: "info", text: `Kept ${node.name}'s ${r} component${r === 1 ? "" : "s"}; they'll be written to ${scene.path} when you stop playing (one undo step).` };
  };
  return (
    <div class="inspector-body runtime-inspector">
      <div class="node-header">
        <input
          type="checkbox"
          checked={node.active}
          aria-label="Active"
          title="Activate or deactivate this node in the running game"
          onChange={(e) => {
            node.setActive((e.currentTarget as HTMLInputElement).checked);
            afterEdit();
          }}
        />
        <span class="node-name">{node.name}</span>
        <span class="live-badge" title="Values are read from the running game; edits change it only">
          live · {world}
        </span>
      </div>
      <div class="keep-actions">
        <button
          disabled={!keepable}
          title={keepable ? "Write every component's current values (Transform included) into the edited scene when you stop playing" : `Can't keep changes: ${mapping.reason}`}
          onClick={keepAll}
        >
          Keep all changes to this node
        </button>
      </div>
      {!keepable && <p class="keep-note">Changes to this node can't be kept: {mapping.reason}</p>}
      <KeptList />
      {components.map((info) => (
        <LiveComponent key={`${info.type}#${info.index}`} node={node} info={info} keepable={keepable} isKept={keepable && kept.value.has(keptKey(mapping.path, info.type, info.index))} onEdit={afterEdit} />
      ))}
      <AddComponentMenu
        targets={[{ node }]}
        onAdd={(type) => {
          const r = addLiveComponent(node, type);
          afterEdit();
          setTick((n) => n + 1);
          if (typeof r === "string") {
            status.value = { kind: "error", text: `Can't add ${titleOf(type)}: ${r}.` };
            return 0;
          }
          status.value = { kind: "info", text: `Added ${titleOf(type)} to ${node.name} in the running game; it isn't kept when you stop.` };
          return 1;
        }}
      />
      <p class="structure-note">Added or removed components and nodes made or deleted here aren't kept when you stop playing.</p>
    </div>
  );
}

/** What will be written on Stop, with a way to drop entries. */
function KeptList() {
  const entries = [...kept.value];
  if (entries.length === 0) return null;
  return (
    <details class="kept-list">
      <summary>
        {entries.length} kept for Stop
        <button
          class="link-button"
          onClick={(e) => {
            e.preventDefault();
            forgetKept();
          }}
        >
          Forget all
        </button>
      </summary>
      <ul>
        {entries.map(([key, k]) => (
          <li key={key}>
            {k.nodeName} › {k.title}
            <button class="link-button" aria-label={`Forget ${k.nodeName} ${k.title}`} onClick={() => forgetKept(key)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

const titleOf = (type: string) => type.replace(/^(engine|game|editor)\./, "");

function LiveComponent(props: { node: GameObject; info: ComponentInfo; keepable: boolean; isKept: boolean; onEdit: () => void }) {
  const { node, info, keepable, isKept, onEdit } = props;
  const title = titleOf(info.type);
  const scene = openScene.value;
  const keep = () => {
    if (!scene) return;
    const r = keepComponent(scene, node, info);
    status.value =
      typeof r === "string"
        ? { kind: "error", text: `Can't keep ${title}: ${r}` }
        : { kind: "info", text: `Kept ${node.name}'s ${title} values; they'll be written to ${scene.path} when you stop playing (one undo step).` };
  };
  return (
    <section class={`component${info.enabled ? "" : " off"}${isKept ? " kept" : ""}`} data-type={info.type}>
      <h3>
        <input
          type="checkbox"
          checked={info.enabled}
          disabled={!info.component}
          aria-label={`${title} enabled`}
          onChange={(e) => {
            if (info.component) info.component.enabled = (e.currentTarget as HTMLInputElement).checked;
            onEdit();
          }}
        />
        {title}
        {info.kind === "data" && <span class="badge">data</span>}
        {isKept && <span class="badge kept-badge">kept</span>}
        <button
          class="remove-live"
          aria-label={`Remove ${title}`}
          disabled={!!whyNotRemoveLive(info)}
          title={whyNotRemoveLive(info) ? `Can't remove: ${whyNotRemoveLive(info)}` : `Remove ${title} from the running game (not kept on Stop)`}
          onClick={() => {
            const reason = removeLiveComponent(node, info);
            status.value = reason ? { kind: "error", text: `Can't remove ${title}: ${reason}.` } : { kind: "info", text: `Removed ${title} from ${node.name} in the running game; it isn't kept when you stop.` };
            onEdit();
          }}
        >
          Remove
        </button>
        <button
          class="keep-values"
          aria-label={`Keep ${title} values`}
          disabled={!keepable}
          title={keepable ? `Write ${title}'s current values into the edited scene when you stop playing${isKept ? " (keeping again updates them)" : ""}` : "This node isn't in the edited scene"}
          onClick={keep}
        >
          Keep values
        </button>
      </h3>
      {info.fields.length === 0 ? (
        <p class="empty">No fields</p>
      ) : (
        <div class="fields">
          {info.fields.map((f) => (
            <LiveField key={f.name} node={node} info={info} field={f} onEdit={onEdit} />
          ))}
        </div>
      )}
    </section>
  );
}

function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

const formatNumber = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

function LiveField(props: { node: GameObject; info: ComponentInfo; field: FieldValue; onEdit: () => void }) {
  const { node, info, field, onEdit } = props;
  const editor = editorFor(field);
  const commit = (json: unknown) => {
    if (!node.isValid) return;
    writeLive(node, info, field.name, json);
    onEdit();
  };
  const v = field.value;
  let control;
  switch (editor) {
    case "number":
    case "integer":
      control = <LiveNumber value={Number(v)} label={field.name} onCommit={(n) => commit(editor === "integer" ? Math.round(n) : n)} />;
      break;
    case "boolean":
      control = <input type="checkbox" checked={Boolean(v)} aria-label={field.name} onChange={(e) => commit((e.currentTarget as HTMLInputElement).checked)} />;
      break;
    case "string":
    case "asset":
      control = <LiveText value={String(v ?? "")} label={field.name} onCommit={(s) => commit(toSceneJSON(editor, s))} />;
      break;
    case "color": {
      const c = v instanceof Color ? v : Color.white;
      control = (
        <input
          type="color"
          aria-label={field.name}
          value={c.toHex()}
          onChange={(e) => {
            const next = Color.from((e.currentTarget as HTMLInputElement).value);
            next.a = c.a;
            commit(toSceneJSON("color", next));
          }}
        />
      );
      break;
    }
    case "vector2":
    case "vector3": {
      if (v === null || v === undefined) {
        control = <span class="none">Auto</span>;
        break;
      }
      const axes = (v as { toArray(): number[] }).toArray();
      control = (
        <span class="vec">
          {axes.map((x, i) => (
            <label key={i} class="axis">
              <em>{"xyzw"[i]}</em>
              <LiveNumber value={x} label={`${field.name} ${"xyzw"[i]}`} onCommit={(n) => commit(axes.map((old, j) => (j === i ? n : old)))} />
            </label>
          ))}
        </span>
      );
      break;
    }
    case "node":
      control = (
        <LiveNodeRef
          node={node}
          value={v instanceof GameObject ? v : null}
          label={field.name}
          onCommit={(target) => {
            const reason = setLiveNodeRef(node, info, field.name, target);
            if (reason) status.value = { kind: "error", text: `Can't set ${field.name}: ${reason}.` };
            onEdit();
          }}
        />
      );
      break;
    default:
      control = <span class="none live-json">{safeJSON(v)}</span>;
  }
  return (
    <>
      <div class="label-cell">
        <label title={field.name}>{humanize(field.name)}</label>
      </div>
      <div class="value">{control}</div>
    </>
  );
}

/** A node reference: None or any node of the same World (ADR 0032 keeps other Worlds out), indented by depth. */
function LiveNodeRef(props: { node: GameObject; value: GameObject | null; label: string; onCommit: (target: GameObject | null) => void }) {
  const choices = liveNodeChoices(props.node.world);
  const v = props.value;
  const current = v && v.isValid ? String(v.entity) : v ? "destroyed" : "";
  return (
    <select
      aria-label={props.label}
      value={current}
      onChange={(e) => {
        const key = (e.currentTarget as HTMLSelectElement).value;
        if (key === "destroyed") return;
        props.onCommit(key === "" ? null : (choices.find((c) => String(c.node.entity) === key)?.node ?? null));
      }}
    >
      <option value="">None</option>
      {v && !v.isValid && (
        <option value="destroyed" disabled>
          (destroyed)
        </option>
      )}
      {choices.map((c) => (
        <option key={c.node.entity} value={String(c.node.entity)}>
          {"  ".repeat(c.depth)}
          {c.name}
        </option>
      ))}
    </select>
  );
}

function safeJSON(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** A number that shows the live value unless it's being typed in; commits on Enter or blur. */
function LiveNumber(props: { value: number; label: string; onCommit: (n: number) => void }) {
  const shown = formatNumber(props.value);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    const n = draft === null || cancelled.current ? null : parseNumber(draft);
    cancelled.current = false;
    setDraft(null);
    if (n !== null && formatNumber(n) !== shown) props.onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input"
      aria-label={props.label}
      value={draft ?? shown}
      onFocus={() => setDraft(shown)}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Text that shows the live value unless it's being typed in; commits on Enter or blur. */
function LiveText(props: { value: string; label: string; onCommit: (s: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    const d = cancelled.current ? null : draft;
    cancelled.current = false;
    setDraft(null);
    if (d !== null && d !== props.value) props.onCommit(d);
  };
  return (
    <input
      type="text"
      aria-label={props.label}
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
