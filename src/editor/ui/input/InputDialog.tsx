// The Input dialog (ADR 0417): every action set and context of the project in one place, opened from File › Input…
// or by opening an `.actions.json` or `.input.json` file. The left list has the sets (asset sets editable, code sets
// read-only) and the contexts, each A to Z, with + to add: a new entry stays at the end, its name selected for typing,
// until the name is committed. Right-click or F2 on an entry: Rename in place, Duplicate, Copy id, Delete (code sets and
// the default context can't be renamed or deleted). The right pane shows the selected set (`ActionSetView`) or context
// (`ContextView`) and lays out by its own width, so it stays readable with History open.
//
// Every edit is one step of one history across the files it touches (`InputDialogHistory`), written at once: Undo,
// Redo and History in the header, Ctrl+Z / Ctrl+Shift+Z while the dialog has focus (it registers as the active
// history). Writing a file goes through the project, which tells `Assets.notifyChanged`, so a playing World picks the
// change up; the footer says Saving…, Saved, or Live (saved and applied to Play). Removals are undoable from a toast.
import { useMemo, useRef, useState } from "preact/hooks";
import { inputActionSets } from "../../../engine/editor";
import { ACTION_SET_EXTENSION, type ActionSetFile } from "../../../engine/input/actionAssets";
import type { ActionKind } from "../../../engine/input/actions";
import type { InputContextSpec } from "../../../engine/input/contextTypes";
import type { NodeEntry, SceneFile } from "../../../engine/scene/SceneLoader";
import { usePanelHistory, type UndoHistory } from "../../activeHistory";
import { actionSetFileName, newSetId, writeActionSet } from "../../actionSetCreate";
import { addAction, formatActionSet, freeActionName, parseActionSet, removeAction, renameAction, setActionType, setSetId, whyNotSetId } from "../../actionSetModel";
import { deleteAssets } from "../../assetDelete";
import { createAsset } from "../../assetKindHost";
import { renameAsset } from "../../assetOps";
import { formatInputContext, parseInputContext, typeForMapping, actionRefFor } from "../../inputContextModel";
import { InputDialogHistory } from "../../inputDialogHistory";
import {
  DEFAULT_CONTEXT_PATH,
  contextEntries,
  contextUsers,
  mapInDefault,
  mappedIn,
  renameInContexts,
  renameSetInContexts,
  retypeInContexts,
  scriptMappings,
  setEntries,
  setInfos,
  type ContextChange,
  type ContextEntry,
  type SetEntry,
} from "../../inputDialogModel";
import type { EditorProject } from "../../projects";
import { currentProject, docVersion, openScene, playState } from "../../state";
import { UndoTree } from "../undoTree/UndoTree";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { useDraftText } from "../draftText";
import { inputDialog } from "../dialogState";
import { UndoToasts, createToastQueue } from "../UndoToast";
import { ActionSetView } from "./ActionSetView";
import { ContextView } from "./ContextView";
import { inputDialogRename } from "./inputDialogIntent";
import "./inputDialog.css";

const CONTEXT_EXTENSION = ".input.json";

/** Each project's dialog history: kept while the project is open, across closing and opening the dialog. */
const histories = new WeakMap<EditorProject, InputDialogHistory>();

function historyFor(project: EditorProject): InputDialogHistory {
  let h = histories.get(project);
  if (!h) histories.set(project, (h = new InputDialogHistory({ read: (p) => project.textOf(p), write: (p, t) => project.writeText(p, t) })));
  return h;
}

/** A key per project, so another project's dialog starts afresh. */
const projectKeys = new WeakMap<EditorProject, number>();
let projectCount = 0;

/** What the dialog showed last, for File › Input… (which asks for no file). */
let lastShown = "";

const codeKey = (id: string) => `code:${id}`;
const keyOfSet = (s: SetEntry) => s.path ?? codeKey(s.id);

export function InputDialog() {
  const request = inputDialog.value;
  const project = currentProject.value;
  if (request === null || !project) return null;
  let key = projectKeys.get(project);
  if (key === undefined) projectKeys.set(project, (key = ++projectCount));
  return <InputDialogBody key={key} project={project} request={request} />;
}

function InputDialogBody(props: { project: EditorProject; request: string }) {
  const { project } = props;
  docVersion.value; // files, scripts and scenes change with it
  const history = historyFor(project);
  history.version.value;
  const root = useRef<HTMLDivElement>(null);
  const toasts = useMemo(() => createToastQueue(), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menu, setMenu] = useState<{ key: string; at: { x: number; y: number } | Element } | null>(null);
  const [focusMapping, setFocusMapping] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const readOnly = !project.canSave;

  // --- the files, as the dialog's edits leave them -------------------------------------------------
  const readJson = (path: string): unknown => {
    const text = history.text(path);
    if (text === undefined) return project.assets.get(path);
    try {
      return JSON.parse(text);
    } catch {
      return project.assets.get(path);
    }
  };
  const engineSets = inputActionSets();
  const setFiles = project.files.filter((f) => f.endsWith(ACTION_SET_EXTENSION));
  const assetSets = setFiles.map((path) => ({ path, spec: parseActionSet(readJson(path), path).value }));
  const contexts = contextEntries(project.files.filter((f) => f.endsWith(CONTEXT_EXTENSION)).map((path) => ({ path, spec: parseInputContext(readJson(path), path).value })));
  const sets = setEntries(assetSets, engineSets);
  const infos = setInfos(sets);
  const scripts = scriptMappings(engineSets);
  const mapped = mappedIn(contexts, infos, scripts);
  const pickerSets = infos.map((s) => ({ id: s.id, editable: s.source === "asset", actions: s.actions }));
  const ids = sets.filter((s) => s.source === "asset").map((s) => s.id);

  // --- selection -----------------------------------------------------------------------------------
  const [selected, setSelected] = useState(() => props.request || lastShown || DEFAULT_CONTEXT_PATH);
  const lastRequest = useRef(props.request);
  if (props.request !== lastRequest.current) {
    lastRequest.current = props.request;
    if (props.request && props.request !== selected) setSelected(props.request);
  }
  const renaming = inputDialogRename.value;
  const selectedSet = sets.find((s) => keyOfSet(s) === selected);
  const selectedContext = contexts.find((c) => c.path === selected);
  const shown = selectedSet ?? selectedContext ?? contexts.find((c) => c.isDefault) ?? contexts[0] ?? sets[0];
  const shownKey = shown ? ("isDefault" in shown ? shown.path : keyOfSet(shown)) : "";
  lastShown = shownKey;
  const select = (key: string, mapping: number | null = null) => {
    setSelected(key);
    setFocusMapping(mapping);
    setMessage(null);
  };

  // --- history ---------------------------------------------------------------------------------------
  const textOf = (path: string) => history.text(path) ?? "";
  const record = (label: string, writes: readonly { path: string; text: string }[]): number | null => {
    if (readOnly) return null;
    setMessage(null);
    return history.record(label, writes.map((w) => ({ path: w.path, before: textOf(w.path), after: w.text }))) ? history.current : null;
  };
  const contextWrites = (changes: readonly ContextChange[]) => changes.map((c) => ({ path: c.path, text: formatInputContext(c.spec) }));
  const editSet = (entry: SetEntry, next: ActionSetFile, label: string, changes: readonly ContextChange[] = []) =>
    entry.path ? record(label, [{ path: entry.path, text: formatActionSet(next) }, ...contextWrites(changes)]) : null;
  const editContext = (path: string, next: InputContextSpec, label: string) => record(label, [{ path, text: formatInputContext(next) }]);
  const moved = (result: ReturnType<InputDialogHistory["go"]>, verb: string) => {
    if (!result && verb) setMessage(`Couldn't ${verb}: a file changed outside the dialog since that step.`);
  };
  /** A toast whose Undo takes back the step `seq`, if it's still the current one. */
  const undoToast = (text: string, seq: number | null) => {
    if (seq === null) return;
    toasts.show({ text, undo: () => (history.current === seq ? moved(history.undo(), "undo") : setMessage("Later edits came after that one; use History to go back.")) });
  };
  const panelHistory = useMemo<UndoHistory>(
    () => ({
      name: "Input",
      get canUndo() {
        return !readOnly && history.canUndo;
      },
      get canRedo() {
        return !readOnly && history.canRedo;
      },
      get undoLabel() {
        return history.undoLabel;
      },
      get redoLabel() {
        return history.redoLabel;
      },
      undo: () => moved(history.undo(), "undo"),
      redo: () => moved(history.redo(), "redo"),
      back: () => moved(history.go("back"), "step back"),
      forward: () => moved(history.go("forward"), "step forward"),
      tree: {
        get states() {
          return history.states;
        },
        get current() {
          return history.current;
        },
        get saved() {
          return history.saved;
        },
        jumpTo: (seq) => moved(history.go(seq), "go there"),
        version: history.version,
      },
    }),
    [history, readOnly],
  );
  usePanelHistory(root, panelHistory);

  // --- set edits --------------------------------------------------------------------------------------
  const setOps = (entry: SetEntry) => {
    const spec = entry.spec!;
    return {
      renameSet: (id: string) => {
        if (id === entry.id) return;
        editSet(entry, setSetId(spec, id), `Rename ${entry.id} to ${id}`, renameSetInContexts(contexts, entry.id, id));
      },
      addAction: () => {
        const name = freeActionName(spec);
        editSet(entry, addAction(spec, name, "button"), `Add action ${name}`);
      },
      renameAction: (from: string, to: string) => editSet(entry, renameAction(spec, from, to), `Rename ${from} to ${to}`, renameInContexts(contexts, { set: entry.id, name: from }, to, infos)),
      retype: (name: string, to: ActionKind) => {
        const from = spec.actions.find((a) => a.name === name)?.type;
        if (!from || from === to) return;
        const changes = retypeInContexts(contexts, { set: entry.id, name }, from, to, infos);
        const seq = editSet(entry, setActionType(spec, name, to), `Change ${name} to ${to}`, changes);
        const notes = changes.flatMap((c) => c.notes);
        if (seq !== null) undoToast(notes.length ? `Changed ${name} to ${to}. ${notes.join(" ")}` : `Changed ${name} to ${to}; its mappings needed no change.`, seq);
      },
      removeAction: (name: string) => undoToast(`Removed ${name}`, editSet(entry, removeAction(spec, name), `Remove action ${name}`)),
    };
  };
  const mapInDefaultContext = (entry: SetEntry, name: string) => {
    const def = contexts.find((c) => c.isDefault);
    if (!def) return setMessage(`There's no ${DEFAULT_CONTEXT_PATH} to map it in.`);
    if (editContext(def.path, mapInDefault(def.spec, actionRefFor(entry.id, name, infos)), `Map ${name} in default`) !== null) select(def.path, def.spec.mappings.length);
  };

  // --- context edits ---------------------------------------------------------------------------------------
  const createActionFor = (context: ContextEntry, set: string, name: string, index: number) => {
    const target = sets.find((s) => s.id === set && s.source === "asset" && s.spec && s.path);
    const m = context.spec.mappings[index];
    if (!target || !m) return;
    const type = typeForMapping(m);
    const shared = infos.some((s) => s.id !== set && s.actions.some((a) => a.name === name));
    const mappings = context.spec.mappings.map((x, i) => (i === index ? { ...x, action: shared ? `${set}:${name}` : name } : x));
    const seq = record(`Add action ${name}`, [
      { path: target.path!, text: formatActionSet(addAction(target.spec!, name, type)) },
      { path: context.path, text: formatInputContext({ ...context.spec, mappings }) },
    ]);
    undoToast(`Added ${name} (${type}) to ${target.path}`, seq);
  };
  const newSetFor = async (context: ContextEntry, name: string, index: number) => {
    const m = context.spec.mappings[index];
    if (!m || readOnly) return;
    const path = await writeActionSet(folderFor(project), { id: newSetId(project), actions: [{ name, type: typeForMapping(m) }] });
    if (!path) return;
    const now = parseInputContext(readJson(context.path), context.path).value;
    const mappings = now.mappings.map((x, i) => (i === index ? { ...x, action: name } : x));
    editContext(context.path, { ...now, mappings }, `Map ${name}`);
    toasts.show({ text: `Made ${path} with ${name}; rename the set from the list.` });
  };

  // --- the list's entries -------------------------------------------------------------------------------------
  const addSet = async () => {
    const path = await writeActionSet(folderFor(project));
    if (!path) return;
    inputDialogRename.value = path;
    select(path);
  };
  const addContext = async () => {
    const path = await createAsset<InputContextSpec>("inputContext", { folder: folderFor(project) });
    if (!path) return;
    inputDialogRename.value = path;
    select(path);
  };
  /** A new entry's name committed: written as it is (no history step: making the file wasn't one), and the file renamed after it. */
  const commitNew = async (key: string, name: string) => {
    inputDialogRename.value = null;
    const set = sets.find((s) => s.path === key);
    const context = contexts.find((c) => c.path === key);
    try {
      if (set?.spec && name !== set.id) {
        await project.writeText(key, formatActionSet(setSetId(set.spec, name)));
        await renameTo(key, actionSetFileName(name));
      } else if (context && name !== context.spec.name) {
        await project.writeText(key, formatInputContext({ ...context.spec, name }));
        await renameTo(key, `${name}${CONTEXT_EXTENSION}`);
      }
    } catch (err) {
      setMessage(`Couldn't rename ${key}: ${(err as Error).message}`);
    }
  };
  const renameTo = async (path: string, fileName: string) => {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const to = folder + fileName;
    if (to === path || project.files.includes(to)) return;
    if (await renameAsset(path, fileName)) select(to);
  };
  const rename = (key: string, name: string) => {
    const set = sets.find((s) => s.path === key);
    const why = set && name !== set.id ? whyNotSetId(name, ids) : null;
    if (why) {
      if (key === renaming) inputDialogRename.value = null;
      return setMessage(`Can't rename ${set!.id} to ${name}: ${why}`);
    }
    if (key === renaming) return void commitNew(key, name);
    if (set) return setOps(set).renameSet(name);
    const context = contexts.find((c) => c.path === key);
    if (context && !context.isDefault && name !== context.spec.name) editContext(key, { ...context.spec, name }, `Rename ${context.name} to ${name}`);
  };
  const [editing, setEditing] = useState<string | null>(null);
  const duplicate = async (key: string) => {
    const set = sets.find((s) => keyOfSet(s) === key);
    const context = contexts.find((c) => c.path === key);
    let path: string | null = null;
    if (set) {
      const actions = set.spec?.actions ?? set.actions.map((a) => ({ name: a.name, type: a.kind, ...(a.consume !== undefined ? { consume: a.consume } : {}) }));
      path = await writeActionSet(folderFor(project), { ...(set.spec ?? {}), id: newSetId(project, `${set.id}Copy`), actions });
    } else if (context) {
      const name = `${context.name} copy`;
      path = await createAsset<InputContextSpec>("inputContext", { folder: folderFor(project), name, value: { ...context.spec, name } });
    }
    if (path) select(path);
  };
  const copyId = (key: string) => {
    const set = sets.find((s) => keyOfSet(s) === key);
    const text = set ? set.id : key;
    void navigator.clipboard?.writeText(text).then(
      () => toasts.show({ text: `Copied ${text}` }),
      () => setMessage(`Couldn't copy ${text}.`),
    );
  };
  const remove = async (key: string) => {
    if (await deleteAssets([key])) select(DEFAULT_CONTEXT_PATH);
  };
  const canRename = (key: string) => !readOnly && (sets.some((s) => s.path === key) || contexts.some((c) => c.path === key && !c.isDefault));
  const menuEntries = (key: string): MenuEntry[] => {
    const fixed = !canRename(key);
    const why = readOnly ? "this project is read-only" : sets.some((s) => keyOfSet(s) === key) ? "it's defined in a script" : "every project has the default context";
    return [
      { id: "rename", label: "Rename", hint: "F2", disabled: fixed, title: fixed ? why : undefined, run: () => setEditing(key) },
      { id: "duplicate", label: "Duplicate", disabled: readOnly, run: () => void duplicate(key) },
      { id: "copy", label: sets.some((s) => keyOfSet(s) === key) ? "Copy id" : "Copy path", run: () => copyId(key) },
      { id: "delete", label: "Delete", danger: true, disabled: fixed, title: fixed ? why : undefined, run: () => void remove(key) },
    ];
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const inField = !!(e.target as HTMLElement).closest("input, select, textarea");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (inField) (e.target as HTMLElement).blur();
      else inputDialog.value = null;
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key ?? "").toLowerCase();
    // Undo and redo go on to the editor's shortcuts, which act on this dialog's history (registered above).
    if (mod && (key === "z" || key === "y")) return;
    e.stopPropagation(); // keep the editor's other shortcuts away from the scene
  };

  // --- what the right pane shows ----------------------------------------------------------------------------------
  const users = useMemo(() => (selectedContext ? contextUsers(selectedContext, sceneFiles(project)) : []), [selectedContext?.path, selectedContext?.spec.name, docVersion.value]);
  let view = null;
  if (shown && "isDefault" in shown) {
    view = (
      <ContextView
        key={shown.path}
        entry={shown}
        sets={infos}
        pickerSets={pickerSets}
        scripts={shown.isDefault ? scripts : []}
        users={users}
        projectReadOnly={readOnly}
        focus={focusMapping}
        onFocused={() => setFocusMapping(null)}
        onEdit={(next, label) => editContext(shown.path, next, label)}
        onRename={(name) => rename(shown.path, name)}
        onRemoveMapping={(i) => undoToast(`Removed mapping ${i + 1}`, editContext(shown.path, { ...shown.spec, mappings: shown.spec.mappings.filter((_, j) => j !== i) }, "Remove Mapping"))}
        onCreateAction={(set, name, i) => createActionFor(shown, set, name, i)}
        onNewSet={(name, i) => void newSetFor(shown, name, i)}
      />
    );
  } else if (shown) {
    const ops = shown.spec ? setOps(shown) : null;
    view = (
      <ActionSetView
        key={keyOfSet(shown)}
        entry={shown}
        ids={ids}
        mapped={mapped}
        projectReadOnly={readOnly}
        onEdit={(next, label) => editSet(shown, next, label)}
        onRenameSet={(id) => ops?.renameSet(id)}
        onAddAction={() => ops?.addAction()}
        onRenameAction={(from, to) => ops?.renameAction(from, to)}
        onRetype={(name, to) => ops?.retype(name, to)}
        onRemoveAction={(name) => ops?.removeAction(name)}
        onMapInDefault={(name) => mapInDefaultContext(shown, name)}
        onJump={(path, index) => select(path, index >= 0 ? index : null)}
      />
    );
  }

  const status = history.failed.value ?? (history.saving.value ? "Saving…" : playState.value !== "edit" ? "Live: saved and applied to Play" : "Saved");
  const atEnd = <T,>(list: T[], key: (t: T) => string) => [...list.filter((t) => key(t) !== renaming), ...list.filter((t) => key(t) === renaming)];
  const entry = (key: string, label: string, meta: string, flags: { clash?: boolean; readOnly?: boolean }) => (
    <ListEntry
      key={key}
      label={label}
      meta={meta}
      clash={flags.clash}
      readOnlyEntry={flags.readOnly}
      selected={key === shownKey}
      editing={key === renaming || key === editing}
      canRename={canRename(key)}
      onSelect={() => select(key)}
      onMenu={(at) => setMenu({ key, at })}
      onEdit={() => canRename(key) && setEditing(key)}
      onCommit={(name) => {
        setEditing(null);
        if (name) rename(key, name);
        else if (key === renaming) inputDialogRename.value = null;
      }}
    />
  );
  return (
    <div class="dialog-backdrop input-dialog-backdrop">
      <div ref={root} class="input-dialog" role="dialog" aria-modal="true" aria-label="Input" tabIndex={-1} onKeyDown={onKeyDown}>
        <header class="input-dialog-head">
          <h2>Input</h2>
          <span class="input-dialog-project">{project.name}</span>
          <span class="input-dialog-spacer" />
          <span class="input-dialog-history" role="group" aria-label="History">
            <button aria-label="Undo" title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : "Nothing to undo"} disabled={!panelHistory.canUndo} onClick={panelHistory.undo}>
              ↶
            </button>
            <button aria-label="Redo" title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo"} disabled={!panelHistory.canRedo} onClick={panelHistory.redo}>
              ↷
            </button>
            <button aria-pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              History
            </button>
          </span>
          <button class="input-dialog-close" aria-label="Close" title="Close (Esc)" onClick={() => (inputDialog.value = null)}>
            ×
          </button>
        </header>
        <div class="input-dialog-body">
          <nav class="input-dialog-list" aria-label="Action sets and contexts">
            <div class="input-list-head">
              <h3>Action sets</h3>
              <button aria-label="New action set" title="New action set" disabled={readOnly} onClick={() => void addSet()}>
                +
              </button>
            </div>
            <ul role="list" aria-label="Action sets">
              {atEnd(sets, keyOfSet).map((s) => entry(keyOfSet(s), s.id, s.source === "code" ? "read-only" : String(s.actions.length), { clash: s.clash, readOnly: s.source === "code" }))}
            </ul>
            <div class="input-list-head">
              <h3>Contexts</h3>
              <button aria-label="New context" title="New context" disabled={readOnly} onClick={() => void addContext()}>
                +
              </button>
            </div>
            <ul role="list" aria-label="Contexts">
              {atEnd(contexts, (c) => c.path).map((c) => entry(c.path, c.name, c.isDefault ? "fallback" : String(c.spec.mappings.length), {}))}
            </ul>
          </nav>
          <main class="input-dialog-main">{view ?? <p class="input-note">Nothing to show yet.</p>}</main>
          {historyOpen && (
            <aside class="input-dialog-tree history-panel" aria-label="Edit history">
              <UndoTree states={history.states} current={history.current} marked={history.saved} markLabel="saved" label="Edit history of the Input dialog" onPick={(seq) => panelHistory.tree!.jumpTo(seq)} />
            </aside>
          )}
        </div>
        <footer class="input-dialog-foot">
          <span class={`input-dialog-status${history.failed.value ? " failed" : ""}`} role="status">
            {message ?? status}
          </span>
          <button onClick={() => (inputDialog.value = null)}>Close</button>
        </footer>
        <UndoToasts queue={toasts} />
        {menu && <ContextMenu entries={menuEntries(menu.key)} at={menu.at} label="Entry menu" onClose={() => setMenu(null)} />}
      </div>
    </div>
  );
}

/** One entry of the left list: its name (an edit box while renaming), a count or note, and its menu. */
function ListEntry(props: {
  label: string;
  meta: string;
  clash?: boolean;
  readOnlyEntry?: boolean;
  selected: boolean;
  editing: boolean;
  canRename: boolean;
  onSelect(): void;
  onMenu(at: { x: number; y: number } | Element): void;
  onEdit(): void;
  onCommit(name: string): void;
}) {
  const draft = useDraftText(props.label, (v) => props.onCommit(v.trim() === props.label ? "" : v.trim()));
  const input = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  if (!props.editing) focused.current = false;
  return (
    <li class={`input-entry${props.selected ? " selected" : ""}${props.clash ? " clash" : ""}`}>
      {props.editing ? (
        <input
          ref={(el) => {
            (input as { current: HTMLInputElement | null }).current = el;
            if (el && !focused.current) {
              focused.current = true;
              queueMicrotask(() => {
                el.focus();
                el.select();
              });
            }
          }}
          type="text"
          aria-label={`Rename ${props.label}`}
          spellcheck={false}
          {...draft.input}
        />
      ) : (
        <button
          class="input-entry-button"
          aria-current={props.selected ? "true" : undefined}
          onClick={props.onSelect}
          onContextMenu={(e) => {
            e.preventDefault();
            props.onSelect();
            props.onMenu({ x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => {
            if (e.key === "F2") {
              e.preventDefault();
              props.onEdit();
            } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              props.onMenu(e.currentTarget);
            }
          }}
        >
          <span class="input-entry-label">{props.label}</span>
          {props.clash && (
            <span class="input-entry-clash" title="A script and an asset both define this id; the asset's set is used">
              clash
            </span>
          )}
          <span class="input-entry-meta">{props.meta}</span>
        </button>
      )}
    </li>
  );
}

/** Where new set and context files go: `input/` when the project has it (it always should: the default context is there). */
const folderFor = (project: EditorProject) => (project.folders.includes("input") ? "input" : "");

/** The project's scenes and prefabs as their nodes, the open scene as edited. */
function sceneFiles(project: EditorProject): { path: string; nodes: readonly NodeEntry[] }[] {
  const open = openScene.peek();
  return project.files
    .filter((f) => f.endsWith(".scene.json") || f.endsWith(".prefab.json"))
    .flatMap((path) => {
      const file = path === open?.path ? open.doc.toJSON() : (project.assets.get(path) as SceneFile | undefined);
      return file && Array.isArray(file.nodes) ? [{ path, nodes: file.nodes }] : [];
    });
}
