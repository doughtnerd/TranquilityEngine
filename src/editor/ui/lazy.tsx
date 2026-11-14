// Lazily loaded editor UI (ADR 0083): a panel or dialog whose module loads the first time it is
// shown (or when `preload` asks), so the editor starts without it. Until then it shows the shared
// placeholder, `<PanelLoading />`. To make a component lazy, wrap a dynamic import:
//
//   const HistoryPanel = lazyComponent(() => import("./HistoryPanel").then((m) => m.HistoryPanel));
//
// and render `<HistoryPanel />` as usual. Nothing else may import that module statically, or its
// code stays in the editor's start-up bundle (it still works, only without the saving).
import { signal } from "@preact/signals";
import type { ComponentChildren, FunctionComponent, JSX } from "preact";
import { Panel } from "./panel/Panel";

/** A component that loads on first render. `preload` starts the load early (it never throws; the render reports failures). */
export interface LazyComponent<P extends object = object> {
  /** Props pass through to the loaded component (none for panels and dialogs). */
  (...props: object extends P ? [props?: P] : [props: P]): ComponentChildren;
  preload(): Promise<void>;
  /** True once the module has loaded. */
  readonly loaded: boolean;
}

/** The placeholder a lazy panel or dialog shows while its code loads, or why it couldn't. */
export function PanelLoading(props: { error?: string; retry?: () => void }): JSX.Element {
  if (props.error === undefined) {
    return (
      <p class="empty panel-loading" role="status" aria-busy="true">
        Loading…
      </p>
    );
  }
  return (
    <p class="empty panel-loading error" role="alert">
      This panel didn't load: {props.error}{" "}
      {props.retry && (
        <button type="button" onClick={props.retry}>
          Try again
        </button>
      )}
    </p>
  );
}

/**
 * Wrap a dynamic import of a component. `placeholder` is what shows while it loads (the shared
 * `<PanelLoading />` by default; dialogs pass `null`, as they have nothing to show until opened; dock panels
 * pass "framed", the placeholder inside a `<Panel>` frame).
 */
export function lazyComponent<P extends object = object>(load: () => Promise<FunctionComponent<P>>, placeholder: "panel" | "framed" | null = "panel"): LazyComponent<P> {
  const component = signal<FunctionComponent<P> | null>(null);
  const error = signal<string | undefined>(undefined);
  let loading: Promise<void> | null = null;
  const preload = (): Promise<void> =>
    (loading ??= load().then(
      (c) => {
        component.value = c;
        error.value = undefined;
      },
      (err: unknown) => {
        console.error(err);
        error.value = err instanceof Error ? err.message : String(err);
        loading = null; // the next render or preload tries again
      },
    ));
  const Lazy = ((props?: P) => {
    const Loaded = component.value;
    if (Loaded) return <Loaded {...(props ?? ({} as P))} />;
    const failed = error.value;
    if (failed === undefined) void preload();
    if (placeholder === null) return null;
    const loading = <PanelLoading error={failed} retry={() => void preload()} />;
    // A dock panel's view (ADR 0174) draws its own `<Panel>` once loaded; until then the placeholder gets one.
    return placeholder === "framed" ? <Panel>{loading}</Panel> : loading;
  }) as unknown as LazyComponent<P>;
  Lazy.preload = preload;
  Object.defineProperty(Lazy, "loaded", { get: () => component.peek() !== null });
  return Lazy;
}

/** Run `task` when the browser is idle (after `timeout` ms at the latest). */
export function whenIdle(task: () => void, timeout = 3000): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => task(), { timeout });
  else setTimeout(task, 200);
}

/**
 * A dialog that loads the first time `isOpen()` is true, and stays mounted from then on (it hides
 * itself when closed, as before). While it loads nothing shows.
 */
export function lazyDialog(isOpen: () => boolean, load: () => Promise<FunctionComponent>): LazyComponent {
  const inner = lazyComponent(load, null);
  let opened = false;
  const Dialog = (() => {
    opened ||= isOpen();
    return opened ? inner() : null;
  }) as LazyComponent;
  Dialog.preload = inner.preload;
  Object.defineProperty(Dialog, "loaded", { get: () => inner.loaded });
  return Dialog;
}
