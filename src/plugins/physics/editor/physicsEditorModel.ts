// The Physics plugin's editor-side logic, as pure functions (ADR 0137): which Components the Add
// Component menu marks "(no physics backend)", and the Project panel's 2D and 3D backend dropdowns.
import { setValue, type SettingsDraft } from "../../../editor/projectSettingsModel";
import type { PhysicsDimension } from "../runtime";

/** The dimension a Physics Component works in: ids ending in "2D" are 2D (RigidBody2D, TilemapCollider2D…), the rest 3D. */
export const componentDimension = (type: string): PhysicsDimension => (/2D$/.test(type) ? "2d" : "3d");

export const NO_BACKEND_NOTE = "(no physics backend)";

/**
 * The note after a Component's name in Add Component: "(no physics backend)" when `myco.physics` is active,
 * the Component is its, and no backend is registered for its dimension; otherwise null. Still addable.
 */
export function noBackendNote(type: string, state: { pluginOf(type: string): string | undefined; backendCount(dimension: PhysicsDimension): number }): string | null {
  if (state.pluginOf(type) !== "myco.physics") return null;
  return state.backendCount(componentDimension(type)) === 0 ? NO_BACKEND_NOTE : null;
}

export const DEFAULT_BACKEND_LABEL = "Default (only registered)";

export interface BackendOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The options of a dimension's backend dropdown: the default (setting unset), each registered backend, and, if the
 * project names one that isn't registered, that name marked "(not enabled)" so the choice stays visible.
 */
export function backendOptions(registered: readonly { id: string; title?: string }[], current: string | undefined): BackendOption[] {
  const out: BackendOption[] = [{ value: "", label: DEFAULT_BACKEND_LABEL }, ...registered.map((r) => ({ value: r.id, label: r.title ?? r.id }))];
  if (current && !registered.some((r) => r.id === current)) out.push({ value: current, label: `${current} (not enabled)` });
  return out;
}

export const backendKey = (dimension: PhysicsDimension) => (dimension === "2d" ? "backend2d" : "backend3d");

/** The backend a draft names for `dimension` ("" when unset). */
export const backendOf = (draft: SettingsDraft, dimension: PhysicsDimension): string => {
  const v = draft.physics?.[backendKey(dimension)];
  return typeof v === "string" ? v : "";
};

/** The draft with `physics.backend2d`/`backend3d` set to `id`, or removed for "" (the default). */
export const setBackend = (draft: SettingsDraft, dimension: PhysicsDimension, id: string): SettingsDraft => setValue(draft, "physics", backendKey(dimension), id === "" ? undefined : id);
