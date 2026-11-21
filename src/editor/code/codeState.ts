// Loading Monaco for the Code panel (ADR 0030), and finding the script that defines a type. Kept apart from the
// Monaco code (code/monaco.ts), which loads lazily. The panel's tabs and unsaved text are the Code buffers'
// (code/codeBuffers.ts, ADR 0308).
import { bufferTexts } from "./codeBuffers";
import type { EditorProject } from "../projects";
import { preloadCodeEditor as preloadCodeEditorSetting } from "../preferences";

type MonacoModule = typeof import("./monaco");

/** Monaco, once loaded (it stays loaded for the session). */
export let loadedMonaco: MonacoModule | null = null;
let loading: Promise<MonacoModule> | null = null;
/** Load Monaco (code/monaco.ts and its chunk), once. */
export const loadMonaco = () => (loading ??= import("./monaco").then((m) => (loadedMonaco = m)));

/**
 * Load Monaco in the background once the editor is idle, so the first file opens without the
 * wait. With scripts in the project, the TypeScript worker starts too (its first start is the
 * slowest part, parsing the engine's declarations).
 */
export function preloadCodeEditor(project: EditorProject): void {
  if (typeof window === "undefined" || typeof document === "undefined") return; // headless tests
  // Settings > General can turn the warm-up off (it costs seconds of CPU on a slow machine); a file or Play still loads Monaco.
  if (!preloadCodeEditorSetting.peek()) return;
  const idle = (run: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 5000 }) : setTimeout(run, 2000));
  idle(() => {
    loadMonaco()
      .then((m) => (project.scripts.size > 0 ? m.warmUp(project, bufferTexts(project)) : undefined))
      .catch(() => {}); // opening a file reports it
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The script that defines component, data component or system `id`: the one whose source
 * registers it with `@behavior("id")`, `defineComponent("id", …)` or `defineSystem({ name: "id" …`.
 * Null if none does (an engine type, or the editor build's).
 */
export function scriptFor(scripts: ReadonlyMap<string, string>, id: string): string | null {
  const quoted = `["'\`]${escapeRegExp(id)}["'\`]`;
  const pattern = new RegExp(`@(?:behavior|component)\\(\\s*${quoted}|defineComponent\\(\\s*${quoted}|name:\\s*${quoted}`);
  for (const [path, source] of scripts) if (pattern.test(source)) return path;
  return null;
}
