// When the desktop editor's hidden editor window is created (ADR 0082, amending ADR 0059). Tauri used
// to create it at start-up beside the Projects window, so the two loaded at once and the editor's
// hundreds of modules held up the Projects window's few. Now tauri.conf.json marks it `create: false`
// and the Projects window creates it here once it has painted and the page is idle, from the same
// window entry, so the editor loads in the background while the user picks a project. Picking one
// before then creates it at once.
import tauriConfig from "../../../src-tauri/tauri.conf.json";

/** The editor window's label (tauri.conf.json, and the capabilities that name it). */
export const EDITOR_WINDOW = "main";

type WindowEntry = { label: string; create?: boolean } & Record<string, unknown>;

/** The options to create the editor window with: its tauri.conf.json entry, less what only the config file reads. */
export function editorWindowOptions(windows: readonly WindowEntry[] = tauriConfig.app.windows as WindowEntry[]): Record<string, unknown> {
  const entry = windows.find((w) => w.label === EDITOR_WINDOW);
  if (!entry) throw new Error(`tauri.conf.json has no "${EDITOR_WINDOW}" window.`);
  const { label: _label, create: _create, ...options } = entry;
  return options;
}

let starting: Promise<void> | null = null;

/**
 * Create the editor window (hidden: it shows itself when it opens a project) unless it exists. Resolves once created.
 * Rust builds it (the `create_editor_window` command, src-tauri/src/lib.rs) from the same tauri.conf.json entry,
 * because only a window built there can carry the `on_new_window` handler that opens the editor's detached panel
 * windows as linked Tauri windows (ADR 0174).
 */
export function startEditorWindow(): Promise<void> {
  starting ??= (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("create_editor_window").catch((err: unknown) => {
      throw new Error(`The editor window couldn't be created: ${String(err)}`);
    });
  })().catch((err: unknown) => {
    starting = null; // let the next try (picking a project) create it
    throw err;
  });
  return starting;
}

/** Create the editor window after this page's first paint, once the browser is idle (or after `timeout` ms at the latest). */
export function startEditorWindowWhenIdle(timeout = 1500): void {
  const idle = (run: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout }) : setTimeout(run, 200));
  requestAnimationFrame(() => requestAnimationFrame(() => idle(() => void startEditorWindow().catch(console.error))));
}
