import { useEffect, useRef, useState } from "preact/hooks";
import { exportOpen } from "./dialogState";
import { getFileSystem, type FileSystem } from "../../engine/platform/FileSystem";
import { desktopExportCommand, exportDesktopProject, exportProjectBuild, isRendezvousUrl, writeDesktopReadme } from "../exportBuild";
import { buildDesktopApp, probeHostToolchain } from "../hostToolchain";
import { assessToolchain, foundTools, type ToolchainProbe } from "../../export/toolchain";
import { joinPath } from "../projectPaths";
import { projectFileSystem } from "../projectFs";
import { currentProject, openScene, status } from "../state";
import "./export.css";



type Target = "web" | "desktop";

/** Build output lines the dialog keeps (a Tauri build prints thousands). */
const LOG_LINES = 300;

/**
 * Build / Export (ADR 0041): write a web build of the project into a folder the user picks, when
 * the platform FileSystem can write (the desktop editor, or a browser with folder access). A
 * desktop app (ADR 0406): the desktop editor checks this computer's toolchain, then writes the
 * desktop package and builds it with that toolchain, or says what's missing; the browser editor
 * shows the command line.
 */
export function ExportDialog() {
  const project = currentProject.value;
  const [target, setTarget] = useState<Target>("web");
  const [audioCapture, setAudioCapture] = useState(false);
  const [audioTake, setAudioTake] = useState(false);
  const [takePictures, setTakePictures] = useState(true);
  const [debugLink, setDebugLink] = useState(false);
  const [debugListen, setDebugListen] = useState(false);
  const [debugLan, setDebugLan] = useState(false);
  const [debugRendezvous, setDebugRendezvous] = useState("");
  const [fs, setFs] = useState<FileSystem | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string; folder?: string } | null>(null);
  // ADR 0406: the host's toolchain: undefined while checking, null where the editor can't run programs (a browser).
  const [toolchain, setToolchain] = useState<ToolchainProbe | null | undefined>(undefined);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const open = exportOpen.value && !!project;
  const checkToolchain = () => {
    setToolchain(undefined);
    probeHostToolchain().then(setToolchain, (err: unknown) => {
      console.warn(`[myco] Couldn't check the build toolchain: ${err instanceof Error ? err.message : String(err)}`);
      setToolchain(null);
    });
  };
  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setLog([]);
    // The project folders' file system (ADR 0038): Tauri, or File System Access in Chromium; else the read-only one.
    void projectFileSystem().then(async (pfs) => setFs(pfs ?? (await getFileSystem())));
    checkToolchain();
  }, [open]);
  useEffect(() => {
    const pre = logRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [log]);
  if (!open || !project) return null;

  const close = () => {
    if (!busy) exportOpen.value = false;
  };
  const canWrite = !!fs?.canWrite;
  const dirty = !!openScene.value?.stack.dirty;
  const rendezvousUrl = debugLink ? debugRendezvous : "";
  const rendezvousBad = rendezvousUrl.trim() !== "" && !isRendezvousUrl(rendezvousUrl);
  /** The build's options, for the web build and the desktop package alike. */
  const buildOptions = () => ({ audioCapture, audioTake, audioTakeFrames: takePictures, ...(debugLink && { debugLink: true as const, ...(debugListen && { debugListen: true as const }), ...(debugListen && debugLan && { debugLan: true as const }), ...(rendezvousUrl.trim() && { debugRendezvous: rendezvousUrl.trim() }) }) });
  const run = async () => {
    if (!fs || rendezvousBad) return;
    const out = await fs.pickFolder(`Choose a folder for the web build of ${project.name}`);
    if (!out) return;
    setBusy(true);
    setMessage({ kind: "info", text: "Compiling scripts…" });
    try {
      const plan = await exportProjectBuild(project, fs, out, (done, total) => setMessage({ kind: "info", text: `Writing files… ${done} of ${total}` }), buildOptions());
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
  const command = desktopExportCommand(project, audioCapture, audioTake, takePictures, debugLink, debugListen, debugLan, debugRendezvous);
  const readiness = toolchain ? assessToolchain(toolchain) : null;
  /** ADR 0406: write the desktop package into a picked folder, then build it with the host's toolchain when it has one. */
  const runDesktop = async () => {
    if (!fs || rendezvousBad) return;
    const cli = readiness?.ready ? readiness.cli : null;
    const out = await fs.pickFolder(`Choose a folder for the desktop app of ${project.name}`);
    if (!out) return;
    setBusy(true);
    setLog([]);
    setMessage({ kind: "info", text: "Compiling scripts…" });
    const options = buildOptions();
    try {
      const plan = await exportDesktopProject(project, fs, out, (done, total) => setMessage({ kind: "info", text: `Writing files… ${done} of ${total}` }), options);
      const name = plan.manifest.name;
      if (!cli) {
        const text = `Wrote the desktop project of ${name} to ${out}. README.txt there says how to build it once the toolchain is installed.`;
        setMessage({ kind: "info", text, folder: out });
        status.value = { kind: "info", text };
        return;
      }
      await buildDesktopApp(
        out,
        cli,
        (line) => setLog((lines) => [...lines.slice(Math.max(0, lines.length - LOG_LINES + 1)), line]),
        (step) => setMessage({ kind: "info", text: step === "icon" ? "Making the app icons…" : "Building the app with tauri build (the first build compiles Tauri, which takes several minutes)…" }),
      );
      await writeDesktopReadme(fs, out, name, true);
      const bundle = joinPath(out, "src-tauri/target/release/bundle");
      const text = `Built ${name}: its installers are in ${bundle}.`;
      setMessage({ kind: "info", text, folder: bundle });
      status.value = { kind: "info", text };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessage({ kind: "error", text });
      status.value = { kind: "error", text: `Desktop build failed: ${text.split("\n")[0]}`, detail: text };
    } finally {
      setBusy(false);
    }
  };

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
        <label class="dialog-option export-audio-capture" title="Press F9 (or hold three fingers for a second) in the exported game to record its audio mix, then again to save a .sporesample file the Profiler opens">
          <input type="checkbox" name="export-audio-capture" checked={audioCapture} disabled={busy} onChange={(e) => setAudioCapture(e.currentTarget.checked)} />
          Let the game record its audio mix (F9)
        </label>
        <p class="export-audio-capture-note" style={{ fontSize: "12px", margin: "-8px 0 12px 22px" }}>
          Players press F9, or hold three fingers for a second, to start recording and again to save a .sporesample file for the Profiler. A capture is labelled: it holds the project's audio settings, name and version, the names of its clips, buses, events and parameters, and part of the browser's user-agent.
        </p>
        <label class="dialog-option export-audio-take" title="Press F10 in the exported game to record a take (what the game asked of audio, with its profile), then again to save a .sporesample file the Studio replays">
          <input type="checkbox" name="export-audio-take" checked={audioTake} disabled={busy} onChange={(e) => setAudioTake(e.currentTarget.checked)} />
          Let the game record audio takes (F10)
        </label>
        <label class="dialog-option export-audio-take-pictures" style={{ marginLeft: "20px" }} title="A take holds a small picture of the game view about once a second, which the Studio shows beside it; leave this off to keep the game's screen out of takes">
          <input type="checkbox" name="export-audio-take-pictures" checked={audioTake && takePictures} disabled={busy || !audioTake} onChange={(e) => setTakePictures(e.currentTarget.checked)} />
          Include pictures of the game view in takes
        </label>
        <label class="dialog-option export-debug-link" title="The game connects to this editor's debug link, so the live debuggers (such as the animation graph's) can inspect it while it runs. Builds without it hold none of the link's code.">
          <input type="checkbox" name="export-debug-link" checked={debugLink} disabled={busy} onChange={(e) => setDebugLink(e.currentTarget.checked)} />
          Debugging on: connect to this editor's debug link
        </label>
        <label class="dialog-option export-debug-listen" style={{ marginLeft: "20px" }} title="The build listens for debugging tools as well as connecting to this editor, so a tool can connect to it (a native build only: a web build can't listen)">
          <input type="checkbox" name="export-debug-listen" checked={debugListen} disabled={busy || !debugLink} onChange={(e) => { setDebugListen(e.currentTarget.checked); if (!e.currentTarget.checked) setDebugLan(false); }} />
          Listen for tools
        </label>
        <label class="dialog-option export-debug-lan" style={{ marginLeft: "40px" }} title="A listening build accepts connections from other machines on its network, each paired by code. Off: only tools on this machine can connect">
          <input type="checkbox" name="export-debug-lan" checked={debugLan} disabled={busy || !debugLink || !debugListen} onChange={(e) => setDebugLan(e.currentTarget.checked)} />
          On the network (LAN)
        </label>
        <label class="dialog-option export-debug-rendezvous" style={{ marginLeft: "20px" }} title="Optional: a hosted rendezvous (a ws:// or wss:// address) that pages and tools use to pair by room code when no rendezvous on the local network is reachable. No public one is run: leave empty unless you host one">
          Rendezvous URL{" "}
          <input type="text" name="export-debug-rendezvous" placeholder="wss://rendezvous.example.com/myco-rendezvous" value={debugRendezvous} disabled={busy || !debugLink} aria-invalid={rendezvousBad} onInput={(e) => setDebugRendezvous(e.currentTarget.value)} />
        </label>
        {rendezvousBad && <p class="export-note" role="alert">The rendezvous address should start with ws:// or wss://.</p>}
        {target === "web" ? (
          <>
            <p>A folder you can put on any web host. Browsers don't run it from disk: run node serve.mjs in it to play locally.</p>
            {!canWrite && fs && <p class="export-note">Exporting writes files, which this browser editor can't do. Use the desktop editor, or the command line: npm run export -- &lt;projectDir&gt;</p>}
            {dirty && <p class="export-note">Unsaved changes to {openScene.value!.path} aren't in the build. Save first to include them.</p>}
          </>
        ) : toolchain === null ? (
          <>
            <p>Desktop apps are built from the command line, with the Rust toolchain installed (rustup.rs). Without Rust, it writes the Tauri project and says how to build it.</p>
            <pre class="export-command"><code>{command}</code></pre>
          </>
        ) : !readiness ? (
          <p class="export-toolchain" role="status">Checking this computer for the build toolchain…</p>
        ) : readiness.ready ? (
          <>
            <p class="export-toolchain">Builds the app with this computer's toolchain, into installers in the folder you choose. The first build compiles Tauri, which takes several minutes.</p>
            <ul class="export-tools">{foundTools(toolchain!).map((line) => <li key={line}>{line}</li>)}</ul>
            {dirty && <p class="export-note">Unsaved changes to {openScene.value!.path} aren't in the build. Save first to include them.</p>}
          </>
        ) : (
          <>
            <p class="export-note export-toolchain-missing" role="alert">You don't have the toolchain to build desktop apps on this computer. Install what's missing, then check again:</p>
            <ul class="export-tools">
              {readiness.missing.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.name}</strong>: {tool.how} <span class="export-url">{tool.url}</span>
                </li>
              ))}
            </ul>
            <p>Until then, the editor can write the desktop project, with a README that says how to build it.</p>
          </>
        )}
        {log.length > 0 && (
          <pre class="export-log" ref={logRef} aria-label="Build output">
            {log.join("\n")}
          </pre>
        )}
        {message && (
          <p class={`export-message${message.kind === "error" ? " problem" : ""}`} role="status" aria-live="polite">
            {message.text}
          </p>
        )}
        <div class="dialog-buttons">
          {message?.folder && fs?.reveal && <button onClick={() => void fs.reveal!(message.folder!)}>Show Folder</button>}
          {target === "desktop" && toolchain === null && (
            <button onClick={() => void navigator.clipboard?.writeText(command)} title="Copy the command">
              Copy Command
            </button>
          )}
          {target === "desktop" && readiness && !readiness.ready && (
            <button onClick={checkToolchain} disabled={busy}>
              Check Again
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
          {target === "desktop" && readiness && (
            <button class="primary" disabled={!canWrite || busy || rendezvousBad} onClick={() => void runDesktop()}>
              {busy ? "Building…" : readiness.ready ? "Choose Folder and Build…" : "Choose Folder and Write Project…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-exported from dialogState.ts (ADR 0083), where the menus read it without loading this dialog. */
export { exportOpen };
