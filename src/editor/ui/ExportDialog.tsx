import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { getFileSystem, type FileSystem } from "../../engine/platform/FileSystem";
import { desktopExportCommand, exportProjectBuild } from "../exportBuild";
import { projectFileSystem } from "../projectFs";
import { currentProject, openScene, status } from "../state";
import "./export.css";

/** The Build / Export dialog is open (ADR 0041). */
export const exportOpen = signal(false);


type Target = "web" | "desktop";

/**
 * Build / Export (ADR 0041): write a web build of the project into a folder the user picks, when
 * the platform FileSystem can write (the desktop editor, or a browser with folder access); a
 * desktop package is made from the command line, which the dialog shows.
 */
export function ExportDialog() {
  const project = currentProject.value;
  const [target, setTarget] = useState<Target>("web");
  const [fs, setFs] = useState<FileSystem | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string; folder?: string } | null>(null);
  const open = exportOpen.value && !!project;
  useEffect(() => {
    if (!open) return;
    setMessage(null);
    // The project folders' file system (ADR 0038): Tauri, or File System Access in Chromium; else the read-only one.
    void projectFileSystem().then(async (pfs) => setFs(pfs ?? (await getFileSystem())));
  }, [open]);
  if (!open || !project) return null;

  const close = () => {
    if (!busy) exportOpen.value = false;
  };
  const canWrite = !!fs?.canWrite;
  const dirty = !!openScene.value?.stack.dirty;
  const run = async () => {
    if (!fs) return;
    const out = await fs.pickFolder(`Choose a folder for the web build of ${project.name}`);
    if (!out) return;
    setBusy(true);
    setMessage({ kind: "info", text: "Compiling scripts…" });
    try {
      const plan = await exportProjectBuild(project, fs, out, (done, total) => setMessage({ kind: "info", text: `Writing files… ${done} of ${total}` }));
      const text = `Exported ${plan.manifest.name} to ${out}. Put the folder on any web host, or run node serve.mjs in it to play locally.`;
      setMessage({ kind: "info", text, folder: out });
      status.value = { kind: "info", text };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessage({ kind: "error", text });
      status.value = { kind: "error", text: `Export failed: ${text.split("\n")[0]}`, detail: text };
    } finally {
      setBusy(false);
    }
  };
  const command = desktopExportCommand(project);

  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id="export-title">Build / Export</h2>
        <fieldset class="new-script-kinds" disabled={busy}>
          <legend>Make a</legend>
          <label title="A static website: the game player, the project's files and its compiled scripts">
            <input type="radio" name="export-target" checked={target === "web"} onChange={() => setTarget("web")} />
            Web build
          </label>
          <label title="A desktop app of the web build, through Tauri">
            <input type="radio" name="export-target" checked={target === "desktop"} onChange={() => setTarget("desktop")} />
            Desktop app
          </label>
        </fieldset>
        {target === "web" ? (
          <>
            <p>A folder you can put on any web host. Browsers don't run it from disk: run node serve.mjs in it to play locally.</p>
            {!canWrite && fs && <p class="export-note">Exporting writes files, which this browser editor can't do. Use the desktop editor, or the command line: npm run export -- &lt;projectDir&gt;</p>}
            {dirty && <p class="export-note">Unsaved changes to {openScene.value!.path} aren't in the build. Save first to include them.</p>}
          </>
        ) : (
          <>
            <p>Desktop apps are built from the command line, with the Rust toolchain installed (rustup.rs). Without Rust, it writes the Tauri project and says how to build it.</p>
            <pre class="export-command"><code>{command}</code></pre>
          </>
        )}
        {message && (
          <p class={`export-message${message.kind === "error" ? " problem" : ""}`} role="status" aria-live="polite">
            {message.text}
          </p>
        )}
        <div class="dialog-buttons">
          {message?.folder && fs?.reveal && <button onClick={() => void fs.reveal!(message.folder!)}>Show Folder</button>}
          {target === "desktop" && (
            <button onClick={() => void navigator.clipboard?.writeText(command)} title="Copy the command">
              Copy Command
            </button>
          )}
          <button onClick={close} disabled={busy}>
            Close
          </button>
          {target === "web" && (
            <button class="primary" disabled={!canWrite || busy} onClick={() => void run()}>
              {busy ? "Exporting…" : "Choose Folder and Export…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
