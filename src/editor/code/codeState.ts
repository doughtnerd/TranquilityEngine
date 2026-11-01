// The Code panel's state (ADR 0030): which scripts are open in it, which one shows, and which
// have unsaved edits. Kept apart from the Monaco code (code/monaco.ts), which loads lazily.
import { signal } from "@preact/signals";
import { showPanel } from "../layout/store";

/** Scripts open as tabs in the Code panel, by project path, in tab order. */
export const openScripts = signal<readonly string[]>([]);
/** The tab showing, or null. */
export const activeScript = signal<string | null>(null);
/** Open scripts whose text differs from what's on disk. */
export const dirtyScripts = signal<ReadonlySet<string>>(new Set());

/** Open a script in the Code panel (as a new tab, or its existing one) and bring the panel forward. */
export function openScript(path: string): void {
  if (!openScripts.value.includes(path)) openScripts.value = [...openScripts.value, path];
  activeScript.value = path;
  showPanel("code");
}

/** Close a script's tab (unsaved edits are the caller's to confirm). The tab beside it shows next. */
export function closeScript(path: string): void {
  const tabs = openScripts.value;
  const at = tabs.indexOf(path);
  if (at < 0) return;
  const rest = tabs.filter((p) => p !== path);
  openScripts.value = rest;
  if (activeScript.value === path) activeScript.value = rest[Math.min(at, rest.length - 1)] ?? null;
  setDirty(path, false);
}

/** Close every tab (another project opened). */
export function closeAllScripts(): void {
  openScripts.value = [];
  activeScript.value = null;
  dirtyScripts.value = new Set();
}

export function setDirty(path: string, dirty: boolean): void {
  if (dirtyScripts.value.has(path) === dirty) return;
  const next = new Set(dirtyScripts.value);
  if (dirty) next.add(path);
  else next.delete(path);
  dirtyScripts.value = next;
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
