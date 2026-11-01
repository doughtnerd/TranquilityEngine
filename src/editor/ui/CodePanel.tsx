import { effect } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type * as Monaco from "monaco-editor";
import { fileName } from "../assetBrowser";
import { activeScript, closeScript, dirtyScripts, openScripts, setDirty } from "../code/codeState";
import { saveScript } from "../session";
import { currentProject, scriptsVersion, status } from "../state";
import { confirmInEditor } from "./ConfirmDialog";

type MonacoModule = typeof import("../code/monaco");

/**
 * The Code panel (ADR 0030): project scripts in tabs, edited with Monaco, which loads the first
 * time the panel shows. Ctrl/Cmd+S saves the script and reloads scripts; a dot marks unsaved
 * edits. Read-only projects open scripts read-only.
 */
export function CodePanel() {
  const project = currentProject.value;
  const tabs = openScripts.value;
  const active = activeScript.value;
  const dirty = dirtyScripts.value;
  scriptsVersion.value; // the tabs follow reloads (a deleted script)
  if (!project) return <p class="empty">No project open</p>;
  if (tabs.length === 0) {
    return (
      <p class="empty">
        {project.scripts.size > 0
          ? "Double-click a script in the Assets panel to open it."
          : project.root === null
            ? "The bundled demo's scripts are part of the editor. Open a project folder to write your own (scripts/*.ts)."
            : "This project has no scripts yet: add .ts files under scripts/."}
      </p>
    );
  }
  return (
    <div class="code-panel">
      <div class="code-tabs" role="tablist" aria-label="Open scripts">
        {tabs.map((path) => (
          <div key={path} class={`code-tab${path === active ? " active" : ""}`} role="tab" aria-selected={path === active} title={path} onClick={() => (activeScript.value = path)}>
            <span class="code-tab-name">{fileName(path)}</span>
            {dirty.has(path) && (
              <span class="code-tab-dirty" aria-label="unsaved changes">
                ●
              </span>
            )}
            {!project.scripts.has(path) && <span class="code-tab-gone">(deleted)</span>}
            <button
              class="code-tab-close"
              aria-label={`Close ${fileName(path)}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(path);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {!project.canSave && <span class="code-readonly">read-only</span>}
      </div>
      <MonacoHost />
    </div>
  );
}

/** Close a tab, asking first if it has unsaved edits (which are then dropped). */
async function closeTab(path: string): Promise<void> {
  if (dirtyScripts.value.has(path)) {
    const answer = await confirmInEditor({
      title: `Close ${fileName(path)}?`,
      message: "It has unsaved changes, which will be lost.",
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (!answer.ok) return;
    const saved = currentProject.value?.scripts.get(path);
    if (loaded) {
      const model = loaded.monaco.editor.getModel(loaded.monaco.Uri.parse(`file:///project/${path}`));
      if (model && saved !== undefined) model.setValue(saved);
      else model?.dispose();
    }
  }
  closeScript(path);
}

/** Monaco, once loaded (it stays loaded for the session). */
let loaded: MonacoModule | null = null;
let loading: Promise<MonacoModule> | null = null;
const loadMonaco = () => (loading ??= import("../code/monaco").then((m) => (loaded = m)));

/** Save the script showing (Ctrl/Cmd+S in the editor). */
async function saveActive(editor: Monaco.editor.IStandaloneCodeEditor): Promise<void> {
  const path = activeScript.value, model = editor.getModel();
  if (!path || !model || !currentProject.value?.canSave) return;
  try {
    await saveScript(path, model.getValue());
    setDirty(path, model.getValue() !== currentProject.value?.scripts.get(path));
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't save ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function MonacoHost() {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    loadMonaco()
      .then(({ monaco, modelFor, syncModels }) => {
        if (cancelled || !host.current) return;
        editor = monaco.editor.create(host.current, {
          theme: "tranquility",
          automaticLayout: true,
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          model: null,
        });
        const e = editor;
        // Ctrl+S and Cmd+S both save, whatever platform Monaco thinks it's on.
        const onSaveKey = (k: KeyboardEvent) => {
          if (!(k.ctrlKey || k.metaKey) || k.altKey || k.key.toLowerCase() !== "s") return;
          k.preventDefault();
          k.stopPropagation();
          void saveActive(e);
        };
        host.current.addEventListener("keydown", onSaveKey, true);
        const watchers = new Map<string, Monaco.IDisposable>();
        // Follow the project's scripts, the tab showing, and read-only-ness.
        stop = effect(() => {
          const project = currentProject.value;
          scriptsVersion.value;
          const path = activeScript.value;
          if (!project) return;
          syncModels(project.scripts, dirtyScripts.peek());
          e.updateOptions({ readOnly: !project.canSave });
          if (!path) return e.setModel(null);
          const model = modelFor(path, project.scripts.get(path) ?? "");
          if (!watchers.has(path)) {
            // Dirty while the text differs from the file on disk.
            watchers.set(path, model.onDidChangeContent(() => setDirty(path, model.getValue() !== currentProject.value?.scripts.get(path))));
            model.onWillDispose(() => {
              watchers.get(path)?.dispose();
              watchers.delete(path);
            });
          }
          if (e.getModel() !== model) e.setModel(model);
        });
      })
      .catch((err) => setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      stop?.();
      editor?.dispose();
    };
  }, []);
  return failed ? <p class="empty error">Couldn't load the code editor: {failed}</p> : <div ref={host} class="code-editor" />;
}
