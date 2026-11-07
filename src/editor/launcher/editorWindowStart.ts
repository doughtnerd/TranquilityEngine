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

/** Create the editor window (hidden: it shows itself when it opens a project) unless it exists. Resolves once created. */
export function startEditorWindow(): Promise<void> {
  starting ??= (async () => {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    if (await WebviewWindow.getByLabel(EDITOR_WINDOW)) return;
    const window = new WebviewWindow(EDITOR_WINDOW, editorWindowOptions() as never);
    await new Promise<void>((resolve, reject) => {
      void window.once("tauri://created", () => resolve());
      void window.once("tauri://error", (e) => reject(new Error(`The editor window couldn't be created: ${JSON.stringify(e.payload)}`)));
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
