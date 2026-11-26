// A screen's dock (ADR 0341 "The shell"): the engine's `DockLayout` over the screen's own layout store and panels,
// with the screen's fixed panel in the middle and Reset layout in the panel menu. On a tablet the left dock folds while
// both sides are open (the host's `foldBelow`); on a phone the screen shows one panel at a time under a row of panel
// tabs (ADR 0361), the fixed panel first, over the same layout, so nothing is lost when the screen is wide again.
import { signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { DockLayout } from "../../editor/layout/DockLayout";
import { instanceTitle, typeOf, type PanelInstanceId } from "../../editor/layout/model";
import { PanelInstanceContext } from "../../editor/ui/panel/Panel";
import { useElementWidth } from "../components/useElementWidth";
import { screenById, type ScreenId } from "./screens";
import { dockOf } from "./screenDocks";
import type { ScreenDockModel } from "./studioPanels";
import { EmptyState } from "../../editor/ui/EmptyState";

/** Below this width (CSS px) the screen shows one panel at a time. */
export const SINGLE_PANEL_BELOW = 640;

/** Each screen's panel showing in the one-panel view (the fixed panel until another is picked). */
const shownPanel = signal<Partial<Record<ScreenId, PanelInstanceId>>>({});

export function ScreenDock(props: { screen: ScreenId }) {
  const dock = dockOf(props.screen);
  const main = useRef<HTMLElement>(null);
  const width = useElementWidth(main);
  const single = width > 0 && width < SINGLE_PANEL_BELOW;
  const empty = <EmptyState compact title="This panel isn't available." />;
  return (
    <main ref={main} class={`studio-dock${single ? " single" : ""}`} aria-label={`${screenById(props.screen)!.title} screen`}>
      {single ? <SinglePanel dock={dock} empty={empty} /> : <DockLayout key={props.screen} host={dock.host} view={(type) => dock.panels.get(type)?.view() ?? empty} />}
    </main>
  );
}

function SinglePanel(props: { dock: ScreenDockModel; empty: preact.ComponentChildren }) {
  const { dock } = props;
  const layout = dock.store.layout.value;
  const catalog = dock.catalog;
  // The filling dock's panels first (the fixed panel), then the side and bottom docks', outermost first.
  const ordered = [...layout.docks.slice(-1), ...layout.docks.slice(0, -1)];
  const panels = ordered.flatMap((d) => d.groups.flatMap((g) => g.panels));
  const picked = shownPanel.value[dock.screen];
  const shown = picked !== undefined && panels.includes(picked) ? picked : (ordered[0]?.groups[0]?.active ?? panels[0]);
  const show = (id: PanelInstanceId) => (shownPanel.value = { ...shownPanel.peek(), [dock.screen]: id });
  const tabId = (id: PanelInstanceId) => `studio-panel-tab-${dock.screen}-${id}`;
  const onKey = (e: KeyboardEvent) => {
    const i = panels.indexOf(shown);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? panels.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const id = panels[(next + panels.length) % panels.length];
    show(id);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`#${CSS.escape(tabId(id))}`)?.focus();
  };
  const title = (id: PanelInstanceId) => instanceTitle(layout, id, catalog);
  return (
    <div class="studio-single">
      <div class="studio-single-tabs" role="tablist" aria-label="Panels" onKeyDown={onKey}>
        {panels.map((id) => (
          <button key={id} id={tabId(id)} type="button" role="tab" class={`studio-single-tab${id === shown ? " on" : ""}`} aria-selected={id === shown} aria-controls="studio-single-body" tabIndex={id === shown ? 0 : -1} onClick={() => show(id)}>
            {title(id)}
          </button>
        ))}
      </div>
      {shown !== undefined && (
        <div id="studio-single-body" class="studio-single-body" role="tabpanel" aria-labelledby={tabId(shown)}>
          <PanelInstanceContext.Provider key={shown} value={{ id: shown, type: typeOf(layout, shown), title: title(shown), close: () => {} }}>
            {dock.panels.get(typeOf(layout, shown))?.view() ?? props.empty}
          </PanelInstanceContext.Provider>
        </div>
      )}
    </div>
  );
}
