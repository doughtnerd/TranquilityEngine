// The frame every panel type renders its content in (ADR 0174). The dock layout provides which panel
// instance is being drawn (`PanelInstanceContext`); a panel type renders `<Panel>` around its content
// and reads its instance and per-instance view state through `usePanel` and `usePanelState`. Plugins
// get these from the editor SDK.
import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import type { Signal } from "@preact/signals";
import { instanceSignal, instanceValue } from "../../layout/instanceState";

/** The panel instance a view is drawn for. */
export interface PanelInstance {
  /** The instance's id (a UUID). */
  readonly id: string;
  /** Its panel type ("hierarchy", "sky"…). */
  readonly type: string;
  /** Its title, as its tab shows it. */
  readonly title: string;
  /** Close this instance (does nothing for the Scene view). */
  close(): void;
}

/** Outside a dock layout (a test rendering a panel on its own): one shared stand-in instance per type. */
const standIn = (type: string): PanelInstance => ({ id: `standalone:${type}`, type, title: type, close() {} });

export const PanelInstanceContext = createContext<PanelInstance | null>(null);

/** The instance the calling component is drawn in. `type` names the stand-in used outside a dock layout. */
export function usePanel(type = "panel"): PanelInstance {
  return useContext(PanelInstanceContext) ?? standIn(type);
}

/**
 * A signal of this panel instance's own view state, under `key`: each copy of a panel has its own, starting from
 * `initial` (the panel type's default). It lives for the session and goes when the instance is closed.
 */
export function usePanelState<T>(key: string, initial: T | (() => T)): Signal<T> {
  return instanceSignal(usePanel().id, key, initial);
}

/** An object kept for this panel instance under `key` (made by `create` the first time), for view state held in a class. */
export function usePanelValue<T>(key: string, create: () => T): T {
  return instanceValue(usePanel().id, key, create);
}

export interface PanelProps {
  /** More classes on the panel element (it always has `panel` and the panel type's id). */
  class?: string;
  /** A row above the content that doesn't scroll with it (search fields, view buttons). */
  toolbar?: ComponentChildren;
  /** More classes on the scrolling body. */
  bodyClass?: string;
  children?: ComponentChildren;
}

/**
 * A panel's frame: the panel element (`section.panel.<type>`), an optional toolbar, and the scrolling
 * body (`.panel-body`) holding the content. The tab above it is the dock layout's (`PanelHeader`).
 */
export function Panel(props: PanelProps) {
  const instance = usePanel();
  return (
    <section class={`panel ${instance.type}${props.class ? ` ${props.class}` : ""}`} data-panel-instance={instance.id}>
      {props.toolbar !== undefined && <div class="panel-toolbar">{props.toolbar}</div>}
      <div class={`panel-body${props.bodyClass ? ` ${props.bodyClass}` : ""}`}>{props.children}</div>
    </section>
  );
}
