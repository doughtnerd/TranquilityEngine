import { errorStatus } from "../messages";
import { Panel } from "./panel/Panel";
import { effect } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type * as Monaco from "monaco-editor";
import { fileName } from "../assetBrowser";
import { activeScript, bufferRewrites, bufferTexts, closeScript, codeFilePath, codeFiles, dirtyScripts, editBuffer, openScripts, revealAt, saveBuffer, showScript } from "../code/codeBuffers";
import { loadMonaco } from "../code/codeState";
import { openScriptExternally, saveCodeFile } from "../session";
import { currentProject, scriptsVersion, status } from "../state";
import { codeAppearance } from "../theme";
import { isScriptPath } from "../projectPaths";
import { confirmInEditor } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";

/**
 * The Code panel (ADR 0030): project scripts, JSON, JavaScript and TypeScript modules (such as
 * a project's Node tools, `tools/*.mjs`), Markdown and text files in tabs, edited with Monaco,
 * which loads the first time the panel shows. Ctrl/Cmd+S saves (a script, or JSON a script
 * imports, reloads scripts); a dot marks unsaved edits. Read-only projects open files read-only.
 * A view of the Code buffers (code/codeBuffers.ts, ADR 0308), which own the tabs and unsaved text.
 */
export function CodePanel() {
  const project = currentProject.value;
  const tabs = openScripts.value;
  const active = activeScript.value;
  const dirty = dirtyScripts.value;
  scriptsVersion.value; // the tabs follow reloads (a deleted script)
  if (!project) return <Panel><EmptyState compact title="No project open" /></Panel>;
  const files = codeFiles(project);
  if (tabs.length === 0) {
    return (
      <Panel>
        <EmptyState
          compact
          title={
            project.scripts.size > 0
              ? "Double-click a script, JSON, JavaScript or text file in the Assets panel to open it."
              : project.root === null
                ? "This project has no scripts."
                : "This project has no scripts yet: add .ts files under scripts/."
          }
        />
      </Panel>
    );
  }
  return (
    <Panel>
      <div class="code-panel">
        <div class="code-tabs" role="tablist" aria-label="Open scripts">
          {tabs.map((path) => (
            <div key={path} class={`code-tab${path === active ? " active" : ""}`} role="tab" aria-selected={path === active} title={path} onClick={() => showScript(path)}>
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
              title={
                isScriptPath(active)
                  ? `Open ${active} in your code editor (the system's app for .ts files). Changes saved there reload here.`
                  : `Open ${active} with the system's app for its file type. Reopen the project to see changes saved there.`
              }
              onClick={() => void openScriptExternally(active)}
            >
              Open Externally
            </button>
          )}
        </div>
        <MonacoHost />
      </div>
    </Panel>
  );
}

/** Close a tab, asking first if it has unsaved edits (closing drops them; the model returns to the file). */
async function closeTab(path: string): Promise<void> {
  if (dirtyScripts.value.has(path)) {
    const answer = await confirmInEditor({
      title: `Close ${fileName(path)}?`,
      message: "It has unsaved changes, which will be lost.",
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (!answer.ok) return;
  }
  closeScript(path);
}

/** Save the file showing (Ctrl/Cmd+S in the editor). */
async function saveActive(): Promise<void> {
  const path = activeScript.value;
  if (!path || !currentProject.value?.canSave) return;
  try {
    await saveBuffer(path, saveCodeFile);
  } catch (err) {
    status.value = errorStatus(`Couldn't save ${path}`, err);
  }
}

function MonacoHost() {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The file being opened, while Monaco loads or its model is made: an overlay says so.
  const [opening, setOpening] = useState<string | null>(activeScript.peek());
  useEffect(() => {
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    loadMonaco()
      .then(({ monaco, modelFor, syncProject }) => {
        if (cancelled || !host.current) return;
        editor = monaco.editor.create(host.current, {
          theme: "myco",
          automaticLayout: true,
          fontFamily: codeAppearance.peek().font,
          fontSize: codeAppearance.peek().size,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          model: null,
        });
        const e = editor;
        // Ctrl+S and Cmd+S both save, whatever platform Monaco thinks it's on.
        const onSaveKey = (k: KeyboardEvent) => {
          if (!(k.ctrlKey || k.metaKey) || k.altKey || (k.key ?? "").toLowerCase() !== "s") return;
          k.preventDefault();
          k.stopPropagation();
          void saveActive();
        };
        host.current.addEventListener("keydown", onSaveKey, true);
        // The code font follows Settings > Appearance.
        const stopFont = effect(() => {
          const { font, size } = codeAppearance.value;
          e.updateOptions({ fontFamily: font, fontSize: size });
          monaco.editor.remeasureFonts();
        });
        const applyReveal = () => {
          const at = revealAt.peek();
          if (!at || activeScript.peek() !== at.path || codeFilePath(e.getModel()?.uri) !== at.path) return;
          revealAt.value = null;
          e.setPosition({ lineNumber: at.line, column: at.column });
          e.revealLineInCenter(at.line);
          e.focus();
        };
        const watchers = new Map<string, Monaco.IDisposable>();
        // Follow the project's scripts, the buffers' text, the tab showing, and read-only-ness.
        const stopFiles = effect(() => {
          const project = currentProject.value;
          scriptsVersion.value;
          bufferRewrites.value;
          const path = activeScript.value;
          if (!project) return;
          // Another project's files replace the last one's (models and the JSON the TypeScript service knows).
          const files = bufferTexts(project);
          syncProject(project, files);
          e.updateOptions({ readOnly: !project.canSave });
          if (!path) {
            setOpening(null);
            return e.setModel(null);
          }
          const model = modelFor(path, files.get(path) ?? "");
          if (!watchers.has(path)) {
            // The buffer takes what's typed (unsaved while it differs from the file on disk).
            watchers.set(path, model.onDidChangeContent(() => editBuffer(path, model.getValue())));
            model.onWillDispose(() => {
              watchers.get(path)?.dispose();
              watchers.delete(path);
            });
          }
          if (e.getModel() !== model) e.setModel(model);
          applyReveal();
          // Clear the overlay once the file has drawn.
          requestAnimationFrame(() => activeScript.peek() === path && setOpening(null));
        });
        // Go to a line asked for (a type error clicked in the Play check's dialog), once its file shows.
        const stopReveal = effect(() => {
          revealAt.value;
          activeScript.value;
          applyReveal();
        });
        stop = () => {
          stopFiles();
          stopFont();
          stopReveal();
        };
      })
      .catch((err) => setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      stop?.();
      editor?.dispose();
    };
  }, []);
  if (failed) return <p class="kit-note" role="alert">Couldn't load the code editor: {failed}</p>;
  return (
    <div class="code-editor-wrap">
      <div ref={host} class="code-editor" />
      {opening && (
        <div class="code-loading" role="status">
          <span class="spinner" aria-hidden="true" />
          Opening {fileName(opening)}…
        </div>
      )}
    </div>
  );
}
