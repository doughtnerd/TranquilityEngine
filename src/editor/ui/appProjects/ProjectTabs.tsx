// The tab strip of an application's projects screen (ADR 0380): caps labels, the selected tab underlined in the
// accent, an optional count badge. A WAI-ARIA tablist: one tab in the Tab order, the arrow keys, Home and End move
// between tabs and select them. Each tab controls the panel with id `<idPrefix>-<tab>-panel` (see `TabPanel`).
import type { ComponentChildren } from "preact";

export interface TabDef<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly badge?: number;
}

export interface ProjectTabsProps<T extends string> {
  readonly tabs: readonly TabDef<T>[];
  readonly selected: T;
  onSelect(id: T): void;
  /** The tablist's accessible name. */
  readonly label: string;
  /** Unique on the page: ties each tab to its panel. */
  readonly idPrefix: string;
}

export function ProjectTabs<T extends string>(props: ProjectTabsProps<T>) {
  const { tabs, selected, onSelect, idPrefix } = props;
  const onKeyDown = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === selected);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(tabs[next].id);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`#${idPrefix}-${tabs[next].id}-tab`)?.focus();
  };
  return (
    <div class="ap-tabs ap-pad" role="tablist" aria-label={props.label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-${t.id}-tab`}
          type="button"
          role="tab"
          class="ap-tab"
          aria-selected={t.id === selected}
          aria-controls={`${idPrefix}-${t.id}-panel`}
          tabIndex={t.id === selected ? 0 : -1}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
          {t.badge !== undefined && <span class="ap-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** The panel of tab `id`, labelled by its tab. */
export function TabPanel(props: { readonly idPrefix: string; readonly id: string; readonly children: ComponentChildren }) {
  return (
    <div class="ap-panel ap-pad" role="tabpanel" id={`${props.idPrefix}-${props.id}-panel`} aria-labelledby={`${props.idPrefix}-${props.id}-tab`}>
      {props.children}
    </div>
  );
}
