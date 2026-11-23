// A screen's dock (ADR 0341 "The shell"): the engine's `DockLayout` over the screen's own layout store and panels,
// with the screen's fixed panel in the middle and Reset layout in the panel menu.
import { DockLayout } from "../../editor/layout/DockLayout";
import { screenById, type ScreenId } from "./screens";
import { dockOf } from "./screenDocks";

export function ScreenDock(props: { screen: ScreenId }) {
  const dock = dockOf(props.screen);
  return (
    <main class="studio-dock" aria-label={`${screenById(props.screen)!.title} screen`}>
      <DockLayout key={props.screen} host={dock.host} view={(type) => dock.panels.get(type)?.view() ?? <p class="empty">This panel isn't available.</p>} />
    </main>
  );
}
