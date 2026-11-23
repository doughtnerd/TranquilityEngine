// Per-instance view state for panels (ADR 0174). Two copies of a panel type share what the editor
// edits and the editor-wide selection, but each keeps its own view state (the Hierarchy's expanded
// rows and search text, the Assets panel's folder…). That state lives here, under the instance's id,
// for the session: a new instance starts from the panel type's defaults, and an instance's state is
// dropped when it leaves the layout (closed, or a layout without it applied).
import { signal, type Signal } from "@preact/signals";

const store = new Map<string, Map<string, unknown>>();

function slot(instance: string): Map<string, unknown> {
  let s = store.get(instance);
  if (!s) store.set(instance, (s = new Map()));
  return s;
}

/** The value kept under `key` for `instance`, made by `create` the first time it's asked for. */
export function instanceValue<T>(instance: string, key: string, create: () => T): T {
  const s = slot(instance);
  if (!s.has(key)) s.set(key, create());
  return s.get(key) as T;
}

/** A signal kept under `key` for `instance`, starting at `initial` (a value, or a function making it). */
export function instanceSignal<T>(instance: string, key: string, initial: T | (() => T)): Signal<T> {
  return instanceValue(instance, `signal:${key}`, () => signal(typeof initial === "function" ? (initial as () => T)() : initial));
}

/** Forget the state of the instances in `ids` (they left their layout). */
export function forgetInstances(ids: Iterable<string>): void {
  for (const id of ids) store.delete(id);
}
