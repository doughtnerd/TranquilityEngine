// One panel's tab (ADR 0174): its title, the red × that closes it, pressing to show it, dragging to
// move it, and right-clicking for the header menu (Add Panel…, Close). The dock layout draws one per
// tab in a group's tab strip; a group holding one panel draws it as its title.

export interface PanelHeaderProps {
  /** The panel instance. */
  id: string;
  title: string;
  /** Shown in its group (the visible tab), or one of a collapsed strip's showing panels. */
  selected: boolean;
  /** The only panel of its group, drawn as the group's title. */
  solo?: boolean;
  /** Draw the × (not for the Scene view, nor while the dock is collapsed). */
  closable: boolean;
  /** Shrunk to fit the header (from the tab strip's measuring). */
  style?: Record<string, string>;
  /** Tooltip; defaults to "<title>: drag to move". */
  tooltip?: string;
  onPress(e: PointerEvent): void;
  onClose(): void;
  onMenu(e: MouseEvent): void;
}

export function PanelHeader(props: PanelHeaderProps) {
  const { id, title, selected, solo, closable } = props;
  return (
    <div
      role="tab"
      aria-label={title}
      aria-selected={selected}
      data-panel-instance={id}
      class={`dock-tab${selected ? " active" : ""}${solo ? " solo" : ""}${closable ? " closable" : ""}`}
      style={props.style}
      title={props.tooltip ?? `${title}: drag to move`}
      onPointerDown={(e) => props.onPress(e)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onMenu(e);
      }}
    >
      <span class="dock-tab-label">{title}</span>
      {closable && (
        <button
          class="dock-tab-close"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
