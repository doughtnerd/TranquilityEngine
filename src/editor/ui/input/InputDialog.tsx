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
// change up; the footer says Saving…, Saved, or Live (saved and applied to Play). Making, naming and deleting a set or
// context are steps of the same history (`inputDialogFiles.ts`), with a set's `input.actionSets` entry in the same
// step; Delete asks nothing and shows a toast whose Undo brings the file (and its entry) back. Mapping cards fold to
// their heads; the folds last while the dialog is open.
import { useMemo, useRef, useState } from "preact/hooks";
import { inputActionSets } from "../../../engine/editor";
import { ACTION_SET_EXTENSION, type ActionSetFile } from "../../../engine/input/actionAssets";
import type { ActionKind } from "../../../engine/input/actions";
import type { InputContextSpec } from "../../../engine/input/contextTypes";
import type { NodeEntry, SceneFile } from "../../../engine/scene/SceneLoader";
import { usePanelHistory, type UndoHistory } from "../../activeHistory";
import { actionSetFileName, newSetId } from "../../actionSetCreate";
import { addAction, formatActionSet, freeActionName, newActionSet, parseActionSet, removeAction, renameAction, setActionType, setSetId, whyNotSetId } from "../../actionSetModel";
import { openScenePaths, whyNotDeletableAsset } from "../../assetDelete";
import { assetDocumentsDeleted } from "../../assetDocuments";
import { codeBuffersDeleted } from "../../code/codeBuffers";
import { emptyInputContext, formatInputContext, parseInputContext, typeForMapping, actionRefFor } from "../../inputContextModel";
import { deleteFileEdits, freeFilePath, makeFileEdits, moveFileEdits, type DialogFiles } from "../../inputDialogFiles";
import { InputDialogHistory, type FileEdit } from "../../inputDialogHistory";
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
const NO_FOLDS: ReadonlySet<number> = new Set();

/** Each project's dialog history: kept while the project is open, across closing and opening the dialog. */
const histories = new WeakMap<EditorProject, InputDialogHistory>();

function historyFor(project: EditorProject): InputDialogHistory {
  let h = histories.get(project);
  if (!h) {
    h = new InputDialogHistory({
      read: (p) => project.textOf(p),
      write: async (p, t) => {
        const made = !project.files.includes(p);
        await project.writeText(p, t);
        if (made) docVersion.value++; // the Assets panel lists it
      },
      remove: async (p) => {
        await project.deleteFile(p);
        codeBuffersDeleted([p]); // a Code panel tab on it closes
        docVersion.value++;
        await assetDocumentsDeleted([p]);
      },
    });
    histories.set(project, h);
  }
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
  /** The mapping cards folded to their heads, by context path: kept while the dialog is open. */
  const [folds, setFolds] = useState<ReadonlyMap<string, ReadonlySet<number>>>(new Map());
  const readOnly = !project.canSave;
  /** The project's files as the dialog's edits leave them (a file being made is listed, one being deleted isn't). */
  const files = history.files(project.files);
  const dialogFiles: DialogFiles = { text: (p) => history.text(p), files };

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
  const setFiles = files.filter((f) => f.endsWith(ACTION_SET_EXTENSION));
  const assetSets = setFiles.map((path) => ({ path, spec: parseActionSet(readJson(path), path).value }));
  const contexts = contextEntries(files.filter((f) => f.endsWith(CONTEXT_EXTENSION)).map((path) => ({ path, spec: parseInputContext(readJson(path), path).value })));
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
  const record = (label: string, writes: readonly { path: string; text: string }[], fileEdits: readonly FileEdit[] = []): number | null => {
    if (readOnly) return null;
    setMessage(null);
    return history.record(label, [...fileEdits, ...writes.map((w) => ({ path: w.path, before: textOf(w.path), after: w.text }))]) ? history.current : null;
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
  const newSetFor = (context: ContextEntry, name: string, index: number) => {
    const m = context.spec.mappings[index];
    if (!m || readOnly) return;
    const id = newSetId(project);
    const path = setPath(id);
    const mappings = context.spec.mappings.map((x, i) => (i === index ? { ...x, action: name } : x));
    const seq = record(`New set ${id} with ${name}`, [{ path: context.path, text: formatInputContext({ ...context.spec, mappings }) }], makeFileEdits(dialogFiles, path, formatActionSet({ id, actions: [{ name, type: typeForMapping(m) }] })));
    undoToast(`Made ${path} with ${name}; rename the set from the list.`, seq);
  };
  /** A free path for a new set file named after `id`, in the folder new files go in. */
  const setPath = (id: string) => freeFilePath(files, folderFor(project), actionSetFileName(id).slice(0, -ACTION_SET_EXTENSION.length), ACTION_SET_EXTENSION);

  // --- the list's entries -------------------------------------------------------------------------------------
  /** Make a file as a step of the history, then show it with its name selected for typing. */
  const addFile = (label: string, path: string, text: string) => {
    if (record(label, [], makeFileEdits(dialogFiles, path, text)) === null) return;
    inputDialogRename.value = path;
    select(path);
  };
  const addSet = () => {
    const id = newSetId(project);
    addFile(`New action set ${id}`, setPath(id), formatActionSet(newActionSet(id)));
  };
  const addContext = () => {
    const value = emptyInputContext();
    addFile("New context", freeFilePath(files, folderFor(project), value.name, CONTEXT_EXTENSION), formatInputContext(value));
  };
  /** A new entry's name committed: one step that writes the name and moves the file to a name after it (when that's free). */
  const commitNew = (key: string, name: string) => {
    inputDialogRename.value = null;
    const set = sets.find((s) => s.path === key);
    const context = contexts.find((c) => c.path === key);
    const folder = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
    const named = (fileName: string) => (/[\\/:*?"<>|]/.test(name) ? key : folder + fileName);
    let to = key;
    if (set?.spec && name !== set.id) {
      to = named(actionSetFileName(name));
      record(`Name ${name}`, [], moveFileEdits(dialogFiles, key, to, formatActionSet(setSetId(set.spec, name))));
    } else if (context && name !== context.spec.name) {
      to = named(`${name}${CONTEXT_EXTENSION}`);
      record(`Name ${name}`, [], moveFileEdits(dialogFiles, key, to, formatInputContext({ ...context.spec, name })));
    }
    if (history.text(to) !== undefined) select(to);
  };
  const rename = (key: string, name: string) => {
    const set = sets.find((s) => s.path === key);
    const why = set && name !== set.id ? whyNotSetId(name, ids) : null;
    if (why) {
      if (key === renaming) inputDialogRename.value = null;
      return setMessage(`Can't rename ${set!.id} to ${name}: ${why}`);
    }
    if (key === renaming) return commitNew(key, name);
    if (set) return setOps(set).renameSet(name);
    const context = contexts.find((c) => c.path === key);
    if (context && !context.isDefault && name !== context.spec.name) editContext(key, { ...context.spec, name }, `Rename ${context.name} to ${name}`);
  };
  const [editing, setEditing] = useState<string | null>(null);
  const duplicate = (key: string) => {
    const set = sets.find((s) => keyOfSet(s) === key);
    const context = contexts.find((c) => c.path === key);
    let made: { path: string; text: string; label: string } | null = null;
    if (set) {
      const actions = set.spec?.actions ?? set.actions.map((a) => ({ name: a.name, type: a.kind, ...(a.consume !== undefined ? { consume: a.consume } : {}) }));
      const id = newSetId(project, `${set.id}Copy`);
      made = { path: setPath(id), text: formatActionSet({ ...(set.spec ?? {}), id, actions }), label: `Duplicate ${set.id}` };
    } else if (context) {
      const name = `${context.name} copy`;
      made = { path: freeFilePath(files, folderFor(project), name, CONTEXT_EXTENSION), text: formatInputContext({ ...context.spec, name }), label: `Duplicate ${context.name}` };
    }
    if (made && record(made.label, [], makeFileEdits(dialogFiles, made.path, made.text)) !== null) select(made.path);
  };
  const copyId = (key: string) => {
    const set = sets.find((s) => keyOfSet(s) === key);
    const text = set ? set.id : key;
    void navigator.clipboard?.writeText(text).then(
      () => toasts.show({ text: `Copied ${text}` }),
      () => setMessage(`Couldn't copy ${text}.`),
    );
  };
  /** Delete a set or context file (and a set's `input.actionSets` entry) as one step, undoable from the toast it shows. */
  const remove = (key: string) => {
    const why = whyNotDeletableAsset(project, key, openScenePaths());
    if (why) return setMessage(`Can't delete ${key}: ${why}.`);
    const set = sets.find((s) => s.path === key);
    const context = contexts.find((c) => c.path === key);
    const users = context ? contextUsers(context, sceneFiles(project)) : [];
    const seq = record(`Delete ${set?.id ?? context?.name ?? key}`, [], deleteFileEdits(dialogFiles, key));
    if (seq === null) return;
    if (shownKey === key) select(DEFAULT_CONTEXT_PATH);
    const still = users.length ? ` ${users.length === 1 ? "A node's InputContext still names it" : `${users.length} nodes' InputContext still name it`}.` : "";
    undoToast(`Deleted ${key}.${still}`, seq);
  };
  const canRename = (key: string) => !readOnly && (sets.some((s) => s.path === key) || contexts.some((c) => c.path === key && !c.isDefault));
  const menuEntries = (key: string): MenuEntry[] => {
    const fixed = !canRename(key);
    const why = readOnly ? "this project is read-only" : sets.some((s) => keyOfSet(s) === key) ? "it's defined in a script" : "every project has the default context";
    return [
      { id: "rename", label: "Rename", hint: "F2", disabled: fixed, title: fixed ? why : undefined, run: () => setEditing(key) },
      { id: "duplicate", label: "Duplicate", disabled: readOnly, run: () => duplicate(key) },
      { id: "copy", label: sets.some((s) => keyOfSet(s) === key) ? "Copy id" : "Copy path", run: () => copyId(key) },
      { id: "delete", label: "Delete", danger: true, disabled: fixed, title: fixed ? why : undefined, run: () => remove(key) },
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
        project={project.root ?? `bundled:${project.name}`}
        scripts={shown.isDefault ? scripts : []}
        users={users}
        projectReadOnly={readOnly}
        focus={focusMapping}
        folded={folds.get(shown.path) ?? NO_FOLDS}
        onFold={(i, f) => {
          const next = new Set(folds.get(shown.path));
          if (f) next.add(i);
          else next.delete(i);
          setFolds(new Map(folds).set(shown.path, next));
        }}
        onFocused={() => setFocusMapping(null)}
        onEdit={(next, label) => editContext(shown.path, next, label)}
        onRename={(name) => rename(shown.path, name)}
        onRemoveMapping={(i) => undoToast(`Removed mapping ${i + 1}`, editContext(shown.path, { ...shown.spec, mappings: shown.spec.mappings.filter((_, j) => j !== i) }, "Remove Mapping"))}
        onCreateAction={(set, name, i) => createActionFor(shown, set, name, i)}
        onNewSet={(name, i) => newSetFor(shown, name, i)}
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
              <button aria-label="New action set" title="New action set" disabled={readOnly} onClick={addSet}>
                +
              </button>
            </div>
            <ul role="list" aria-label="Action sets">
              {atEnd(sets, keyOfSet).map((s) => entry(keyOfSet(s), s.id, s.source === "code" ? "read-only" : String(s.actions.length), { clash: s.clash, readOnly: s.source === "code" }))}
            </ul>
            <div class="input-list-head">
              <h3>Contexts</h3>
              <button aria-label="New context" title="New context" disabled={readOnly} onClick={addContext}>
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
