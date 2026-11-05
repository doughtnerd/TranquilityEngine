import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GameObject } from "../../engine";
import type { ComponentTypeInfo } from "../../engine/editor";
import { addComponentTo, componentCatalog, whyNotAddable } from "../componentEdits";
import { buildMenuTree, type MenuNode } from "../componentCategories";
import type { NodePath } from "../document";
import { newScript } from "../newScript";
import { recentComponents } from "../preferences";
import { currentProject, status, type OpenScene } from "../state";

/**
 * The Inspector's Add Component button (ADR 0022): a menu of every component type in submenus
 * (engine categories, Scripts by folder, Data), with the last few added on top. Types none of the
 * selected nodes can take are greyed out with the reason. Typing searches all types as a flat list
 * showing each one's category. Arrows move, Right/Enter opens a submenu or adds, Left closes a
 * submenu, Escape closes one level, then the menu.
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
const RECENT = 5;
const HOVER_DELAY = 150;

type Row = ComponentTypeInfo & { reason: string | null };
type Entry = { kind: "item"; item: Row } | { kind: "cat"; node: MenuNode<Row> };
const entriesOf = (n: MenuNode<Row>): Entry[] => [...n.children.map((node): Entry => ({ kind: "cat", node })), ...n.items.map((item): Entry => ({ kind: "item", item }))];
const takeable = (e: Entry) => e.kind === "cat" || e.item.reason === null;

/** A submenu beside the row that opened it (to the right, or the left when there's no room). */
function Flyout(props: { anchorKey: string; label: string; children: ComponentChildren }) {
  const el = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<Record<string, string>>({ opacity: "0" });
  useLayoutEffect(() => {
    const anchor = document.querySelector(`.add-component-menu [data-row="${props.anchorKey}"]`);
    const me = el.current;
    if (!anchor || !me) return;
    const r = anchor.getBoundingClientRect();
    const w = me.offsetWidth;
    const h = Math.min(me.scrollHeight, innerHeight - 16);
    const left = r.right + w <= innerWidth - 4 ? r.right - 2 : Math.max(4, r.left - w + 2);
    const top = Math.max(8, Math.min(r.top - 4, innerHeight - h - 8));
    setPlace({ left: `${left}px`, top: `${top}px`, maxHeight: `${innerHeight - 16}px` });
  }, [props.anchorKey]);
  return (
    <ul ref={el} class="add-component-flyout" role="menu" aria-label={props.label} style={place}>
      {props.children}
    </ul>
  );
}

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
  const [active, setActive] = useState(0); // search mode: the highlighted match
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const catalog: Row[] = componentCatalog().map((t) => {
    // Greyed out only when no selected node can take it; otherwise it goes on those that can.
    const reasons = targets.map((x) => whyNotAddable(x.node, t.id));
    return { ...t, reason: reasons.every((r) => r !== null) ? reasons[0] : null };
  });
  const scripts = currentProject.value?.scripts;
  const catalogKey = catalog.map((t) => `${t.id}:${t.reason ?? ""}`).join(",");
  const tree = useMemo(() => buildMenuTree(catalog, scripts ?? new Map()), [catalogKey, scripts]);
  const pathOf = new Map<string, string>();
  const walk = (n: MenuNode<Row>) => {
    for (const i of n.items) pathOf.set(i.id, n.path.join(" › "));
    n.children.forEach(walk);
  };
  tree.forEach(walk);

  const recent: Row[] = recentComponents.value.flatMap((id) => catalog.filter((t) => t.id === id));
  const rootEntries: Entry[] = [...recent.map((item): Entry => ({ kind: "item", item })), ...tree.map((n): Entry => ({ kind: "cat", node: n }))];

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const matches = catalog.filter((t) => words.every((w) => t.name.toLowerCase().includes(w) || t.id.toLowerCase().includes(w)));
  const enabled = matches.filter((i) => i.reason === null);
  const current = enabled[Math.min(active, enabled.length - 1)];

  // Browse mode: levels[j] is the highlighted row of open panel j (-1: none yet). A highlighted
  // submenu with another level after it is open.
  const [levels, setLevels] = useState<number[]>([0]);
  const panels: Entry[][] = [rootEntries];
  for (let j = 0; j + 1 < levels.length; j++) {
    const e = panels[j]![levels[j]!];
    if (e?.kind !== "cat") break;
    panels.push(entriesOf(e.node));
  }
  const open = levels.slice(0, panels.length);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const add = (id: string) => {
    const n = addComponentTo(scene, targets, id);
    const name = id.replace(/^[^.]*\./, "");
    recentComponents.value = [id, ...recentComponents.value.filter((x) => x !== id)].slice(0, RECENT);
    if (targets.length > 1) status.value = { kind: "info", text: `Added ${name} to ${n} of ${targets.length} nodes.` };
    close();
  };
  const openLevels = (depth: number, index: number, entry: Entry) => setLevels([...open.slice(0, depth), index, ...(entry.kind === "cat" ? [-1] : [])]);
  const hover = (depth: number, index: number, entry: Entry) => {
    clearTimeout(hoverTimer.current);
    if (!takeable(entry)) return;
    hoverTimer.current = setTimeout(() => openLevels(depth, index, entry), HOVER_DELAY);
  };
  const step = (dir: 1 | -1) => {
    const d = open.length - 1;
    const es = panels[d]!;
    for (let i = open[d]! + dir; i >= 0 && i < es.length; i += dir) {
      if (takeable(es[i]!)) return setLevels([...open.slice(0, d), i]);
    }
  };
  const activate = () => {
    const d = open.length - 1;
    const e = panels[d]![open[d]!];
    if (!e) return;
    if (e.kind === "item") return e.item.reason === null ? add(e.item.id) : undefined;
    setLevels([...open, Math.max(0, entriesOf(e.node).findIndex(takeable))]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (searching) {
      if (e.key === "ArrowDown") setActive(Math.min(active + 1, enabled.length - 1));
      else if (e.key === "ArrowUp") setActive(Math.max(active - 1, 0));
      else if (e.key === "Enter" && current) add(current.id);
      else if (e.key === "Escape") close();
      else return;
    } else if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "ArrowRight" || e.key === "Enter") activate();
    else if (e.key === "ArrowLeft") {
      if (open.length > 1) setLevels(open.slice(0, -1));
    } else if (e.key === "Escape") {
      if (open.length > 1) setLevels(open.slice(0, -1));
      else close();
    } else return;
    e.preventDefault();
    e.stopPropagation(); // keep editor shortcuts out of the search box
  };

  const typeRow = (item: Row, key: string, extra: Record<string, unknown>) => (
    <li
      key={key}
      aria-disabled={item.reason !== null}
      title={item.reason ? `Can't add: ${item.reason}` : item.id}
      onPointerDown={(e) => e.preventDefault() /* keep focus in the search box */}
      onClick={() => item.reason === null && add(item.id)}
      {...extra}
    >
      {item.name}
    </li>
  );

  const panelRows = (es: Entry[], depth: number) =>
    es.map((entry, i) => {
      const key = `${depth}-${i}`;
      const sel = open[depth] === i;
      const isLast = depth === open.length - 1;
      if (entry.kind === "cat") {
        return (
          <li
            key={key}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={sel && !isLast}
            data-row={key}
            class={`category${sel ? (isLast ? " active" : " open") : ""}`}
            onPointerDown={(e) => e.preventDefault()}
            onPointerEnter={() => hover(depth, i, entry)}
            onClick={() => {
              clearTimeout(hoverTimer.current);
              openLevels(depth, i, entry);
            }}
          >
            {entry.node.label}
            <span class="caret" aria-hidden="true">
              ▸
            </span>
          </li>
        );
      }
      const r = entry.item;
      return typeRow(r, key, {
        role: "menuitem",
        "data-row": key,
        class: `${sel && isLast ? "active" : ""}${r.reason ? " disabled" : ""}`,
        onPointerEnter: () => hover(depth, i, entry),
      });
    });

  // Keep the keyboard's row in view.
  useEffect(() => {
    document.querySelector(".add-component-menu li.active, .add-component-flyout li.active")?.scrollIntoView?.({ block: "nearest" });
  }, [levels, active]);

  const rootRows = panelRows(rootEntries, 0);
  if (recent.length > 0) {
    rootRows.splice(
      0,
      0,
      <li key="recent-heading" class="group" role="presentation">
        Recent
      </li>,
    );
    rootRows.splice(recent.length + 1, 0, <li key="recent-sep" class="separator" role="separator" />);
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
            setLevels([0]);
          }}
          onKeyDown={onKeyDown}
        />
        {searching ? (
          <ul role="listbox" aria-label="Component types">
            {matches.length === 0 && (
              <li class="empty" role="presentation">
                No matching components
              </li>
            )}
            {matches.map((item) =>
              typeRow(item, item.id, {
                role: "option",
                "aria-selected": item === current,
                "data-path": pathOf.get(item.id),
                class: `${item === current ? "active" : ""}${item.reason ? " disabled" : ""}`,
              }),
            )}
          </ul>
        ) : (
          <ul role="menu" aria-label="Component categories">
            {rootRows}
          </ul>
        )}
        {!searching &&
          panels.slice(1).map((es, j) => (
            <Flyout key={open.slice(0, j + 1).join("-")} anchorKey={`${j}-${open[j]}`} label={(panels[j]![open[j]!] as { node: MenuNode<Row> }).node.label}>
              {panelRows(es, j + 1)}
            </Flyout>
          ))}
        {currentProject.value?.root != null && (
          <button
            class="new-script-item"
            disabled={!currentProject.value.canSave}
            title="Write a new script (or data component) and add it to the selected nodes"
            onPointerDown={(e) => e.preventDefault() /* keep the search box focused until chosen */}
            onClick={() => {
              close();
              void newScript({ addTo: targets });
            }}
          >
            New script…
          </button>
        )}
      </div>
    </>
  );
}
