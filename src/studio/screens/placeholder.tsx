// Panels a screen shows until its milestone fills them (ADR 0341 plan, M3–M9): the editor's panel frame around an
// empty state saying what the panel is for. And the History panel every screen can add (the engine's history tree,
// ADR 0341 "Undo and history are the engine's").
import type { ComponentChildren } from "preact";
import type { PanelDock } from "../../editor/sdk/contributions";
import { EmptyState } from "../../editor/ui/EmptyState";
import { HistoryView } from "../../editor/ui/HistoryPanel";
import { Panel } from "../../editor/ui/panel/Panel";
import type { StudioPanel } from "../shell/studioPanels";
import type { ScreenId } from "../shell/screens";

export interface PlaceholderOptions {
  readonly id: string;
  readonly title: string;
  readonly dock: PanelDock;
  readonly fixed?: boolean;
  readonly onDemand?: boolean;
  /** The empty state's title and what the panel is for. */
  readonly empty: string;
  readonly body: ComponentChildren;
  readonly icon?: string;
}

export function placeholderPanel(o: PlaceholderOptions): StudioPanel {
  return {
    id: o.id,
    title: o.title,
    dock: o.dock,
    fixed: o.fixed,
    onDemand: o.onDemand,
    view: () => (
      <Panel bodyClass="studio-panel-body">
        <EmptyState title={o.empty} body={o.body} icon={o.icon} compact={!o.fixed} />
      </Panel>
    ),
  };
}

/** The History panel on a screen: the focused document's history tree, in the Studio's words. */
export function historyPanel(screen: ScreenId): StudioPanel {
  return {
    id: `${screen}-history`,
    title: "History",
    dock: "right",
    onDemand: true,
    view: () => (
      <Panel>
        <HistoryView wording={{ none: "Click into a document on this screen to see its edit history." }} />
      </Panel>
    ),
  };
}
