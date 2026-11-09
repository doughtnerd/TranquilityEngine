// Plugins' extensions to a built-in panel (ADR 0133): extra UI rendered in a panel's own content, the Worlds
// panel's navigation counters under it, and (ADR 0146) the Scene panel's overlays over the scene view (the
// Particles plugin's preview controls). Kept apart from panels.tsx so the Scene panel can render them.
import { panelExtensions, type PanelExtensionContribution } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";

// One lazy wrapper per contribution object; no placeholder, as they show nothing until they have something to say.
const extensionViews = new WeakMap<PanelExtensionContribution, LazyComponent>();
export const lazyExtension = (e: PanelExtensionContribution): LazyComponent => {
  let lazy = extensionViews.get(e);
  if (!lazy) extensionViews.set(e, (lazy = lazyComponent(e.view, null)));
  return lazy;
};
export const extensionsOf = (panel: string) => panelExtensions.list().filter((e) => e.panel === panel);

/** What plugins registered for a built-in panel, in registration order (a live view of the registry). */
export function PanelExtensions(props: { panel: string }) {
  void panelExtensions.version.value;
  return <>{extensionsOf(props.panel).map((e) => lazyExtension(e)())}</>;
}

