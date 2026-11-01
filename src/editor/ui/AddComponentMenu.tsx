import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GameObject } from "../../engine";
import { addComponentTo, componentCatalog, whyNotAddable } from "../componentEdits";
import type { NodePath } from "../document";
import { status, type OpenScene } from "../state";

/**
 * The Inspector's Add Component button (ADR 0022): a searchable list of every component type,
 * grouped into Engine, Scripts and Data. Types none of the selected nodes can take are greyed out
 * with the reason. Type to filter, arrows to move, Enter or click to add, Escape to close.
 */
export function AddComponentMenu(props: { scene: OpenScene; targets: { path: NodePath; node: GameObject }[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div class="add-component" ref={anchor}>
      <button class="add-component-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Add Component
      </button>
      {open && <Menu {...props} anchor={anchor.current!} close={() => setOpen(false)} />}
    </div>
  );
}

const MENU_HEIGHT = 320;

function Menu(props: { scene: OpenScene; targets: { path: NodePath; node: GameObject }[]; anchor: HTMLElement; close: () => void }) {
  const { scene, targets, close } = props;
  // Fixed to the window, so the Inspector's scrolling panel doesn't clip it: below the button,
  // or above it when there isn't room.
  const [place, setPlace] = useState<Record<string, string>>({ opacity: "0" }); // until placed; still focusable
  useLayoutEffect(() => {
    const r = props.anchor.getBoundingClientRect();
    const below = innerHeight - r.bottom >= Math.min(MENU_HEIGHT, r.top);
    setPlace({
      left: `${r.left + 8}px`,
      width: `${r.width - 16}px`,
      ...(below ? { top: `${r.bottom - 8}px` } : { bottom: `${innerHeight - r.top - 4}px` }),
      maxHeight: `${Math.min(MENU_HEIGHT, (below ? innerHeight - r.bottom : r.top) - 12)}px`,
    });
  }, []);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = componentCatalog()
    .filter((t) => words.every((w) => t.name.toLowerCase().includes(w) || t.id.toLowerCase().includes(w)))
    .map((t) => {
      // Greyed out only when no selected node can take it; otherwise it goes on those that can.
      const reasons = targets.map((x) => whyNotAddable(x.node, t.id));
      return { ...t, reason: reasons.every((r) => r !== null) ? reasons[0] : null };
    });
  const enabled = items.filter((i) => i.reason === null);
  const current = enabled[Math.min(active, enabled.length - 1)];

  const add = (id: string) => {
    const n = addComponentTo(scene, targets, id);
    const name = id.replace(/^[^.]*\./, "");
    if (targets.length > 1) status.value = { kind: "info", text: `Added ${name} to ${n} of ${targets.length} nodes.` };
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive(Math.min(active + 1, enabled.length - 1));
    else if (e.key === "ArrowUp") setActive(Math.max(active - 1, 0));
    else if (e.key === "Enter" && current) add(current.id);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation(); // keep editor shortcuts out of the search box
  };

  // One flat list: a heading row before the first type of each group.
  const rows: preact.JSX.Element[] = [];
  let group = "";
  for (const item of items) {
    if (item.group !== group) {
      group = item.group;
      rows.push(
        <li key={`group-${group}`} class="group" role="presentation">
          {group}
        </li>,
      );
    }
    rows.push(
      <li
        key={item.id}
        role="option"
        aria-selected={item === current}
        aria-disabled={item.reason !== null}
        class={`${item === current ? "active" : ""}${item.reason ? " disabled" : ""}`}
        title={item.reason ? `Can't add: ${item.reason}` : item.id}
        onPointerDown={(e) => e.preventDefault() /* keep focus in the search box */}
        onClick={() => item.reason === null && add(item.id)}
      >
        {item.name}
      </li>,
    );
  }

  return (
    <>
      <div class="menu-backdrop" onPointerDown={close} />
      <div class="add-component-menu" role="dialog" aria-label="Add component" style={place}>
        <input
          ref={input}
          type="search"
          placeholder="Search components"
          aria-label="Search components"
          value={query}
          onInput={(e) => {
            setQuery((e.currentTarget as HTMLInputElement).value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul role="listbox" aria-label="Component types">
          {items.length === 0 && <li class="empty" role="presentation">No matching components</li>}
          {rows}
        </ul>
      </div>
    </>
  );
}
