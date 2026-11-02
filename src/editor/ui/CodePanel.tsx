import { errorStatus } from "../messages";
import { effect } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type * as Monaco from "monaco-editor";
import { fileName } from "../assetBrowser";
import { activeScript, closeScript, codeFiles, dirtyScripts, openScripts, setDirty } from "../code/codeState";
import { openScriptExternally, saveCodeFile } from "../session";
import { currentProject, scriptsVersion, status } from "../state";
import { confirmInEditor } from "./ConfirmDialog";

type MonacoModule = typeof import("../code/monaco");

/**
 * The Code panel (ADR 0030): project scripts, JSON and JavaScript files in tabs, edited with
 * Monaco, which loads the first time the panel shows. Ctrl/Cmd+S saves (a script, or JSON a
 * script imports, reloads scripts); a dot marks unsaved edits. Read-only projects open files
 * read-only.
 */
export function CodePanel() {
  const project = currentProject.value;
  const tabs = openScripts.value;
  const active = activeScript.value;
  const dirty = dirtyScripts.value;
  scriptsVersion.value; // the tabs follow reloads (a deleted script)
  if (!project) return <p class="empty">No project open</p>;
  const files = codeFiles(project);
  if (tabs.length === 0) {
    return (
      <p class="empty">
        {project.scripts.size > 0
          ? "Double-click a script, JSON or JavaScript file in the Assets panel to open it."
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
            {!files.has(path) && <span class="code-tab-gone">(deleted)</span>}
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
        {active && project.fileSystem?.openExternally && (
          <button
            class="code-external"
            title={`Open ${active} in your code editor (the system's app for .ts files). Changes saved there reload here.`}
            onClick={() => void openScriptExternally(active)}
          >
            Open Externally
          </button>
        )}
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
    const saved = currentProject.value ? codeFiles(currentProject.value).get(path) : undefined;
    if (loaded) {
      const model = loaded.monaco.editor.getModel(loaded.monaco.Uri.parse(`file:///project/${path}`));
      if (model && saved !== undefined) model.setValue(saved);
      else model?.dispose();
    }
  }
  closeScript(path);
}

/** The project whose files Monaco's models hold: when another opens, they're dropped first. */
let modelsProject: unknown = null;

/** Monaco, once loaded (it stays loaded for the session). */
let loaded: MonacoModule | null = null;
let loading: Promise<MonacoModule> | null = null;
const loadMonaco = () => (loading ??= import("../code/monaco").then((m) => (loaded = m)));

/** Save the file showing (Ctrl/Cmd+S in the editor). */
async function saveActive(editor: Monaco.editor.IStandaloneCodeEditor): Promise<void> {
  const path = activeScript.value, model = editor.getModel();
  const project = currentProject.value;
  if (!path || !model || !project?.canSave) return;
  try {
    await saveCodeFile(path, model.getValue());
    setDirty(path, model.getValue() !== codeFiles(project).get(path));
  } catch (err) {
    status.value = errorStatus(`Couldn't save ${path}`, err);
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
      .then(({ monaco, modelFor, syncModels, disposeModels }) => {
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
          if (modelsProject !== project) {
            // Another project: its files replace the last one's (models and the JSON the TypeScript service knows).
            disposeModels();
            modelsProject = project;
          }
          const files = codeFiles(project);
          syncModels(files, dirtyScripts.peek());
          e.updateOptions({ readOnly: !project.canSave });
          if (!path) return e.setModel(null);
          const model = modelFor(path, files.get(path) ?? "");
          if (!watchers.has(path)) {
            // Dirty while the text differs from the file on disk.
            const onDisk = () => (currentProject.value ? codeFiles(currentProject.value).get(path) : undefined);
            watchers.set(path, model.onDidChangeContent(() => setDirty(path, model.getValue() !== onDisk())));
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
