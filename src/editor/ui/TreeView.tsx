// The editor's one tree view (ADR 0278): the Hierarchy (scene nodes, prefab instances' inner nodes and UI document
// elements), the live Hierarchy of a running World and the Assets panel's folders all draw with it. It owns what a
// tree does: rows with a caret, collapse, the keyboard (Up/Down/Home/End move and select, Right opens or steps in,
// Left closes or steps out, F2 renames, Delete removes), renaming in place, the drop indicator a drag asks for, and
// the ARIA tree pattern (tree, treeitem, group, aria-level, aria-expanded, aria-selected, one tab stop that roves).
//
// Adapters supply each item set's rows and edits as `TreeRow`s: what a row shows and what selecting, opening,
// renaming, removing or dragging it does. Rows from different item sets mix in one tree (a node's UI document
// elements sit under its children), each with its own edits. Which row is being renamed is kept per tree name
// (`renameRow`), so a menu item can start a rename the tree then shows.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { signal, type Signal } from "@preact/signals";
import { RenameField } from "./RenameField";
import "./tree.css";

/** How a row was picked: a plain click or arrow key, Ctrl/Cmd+click (toggle) or Shift+click (a range of `visible`). */
export interface TreeSelect {
  readonly toggle: boolean;
  readonly range: boolean;
  /** The keys of the rows showing, top to bottom (for a range). */
  readonly visible: readonly string[];
}

/** Renaming a row in place: the name it starts from and what committing does. */
export interface TreeRename {
  readonly value: string;
  /** The field's accessible name ("Node name"). */
  readonly label: string;
  readonly placeholder?: string;
  /** Characters selected at the start (default: all). */
  readonly selectTo?: number;
  /** The text as typed when Enter or blur ends it (the adapter compares it with the old name). */
  commit(value: string): void;
  /** Escape ended it without a change (a row made just now can take itself away). */
  cancel?(): void;
}

/** One row of a tree and its edits, from an adapter. */
export interface TreeRow {
  /** Unique within the tree. */
  readonly key: string;
  readonly label: string;
  /** The rows under it, needed only while it's open. */
  readonly children?: readonly TreeRow[];
  readonly expandable: boolean;
  readonly open: boolean;
  readonly selected: boolean;
  /** Extra classes on the row element (`inactive`, `inner`, `ui-element`…). */
  readonly className?: string;
  /** Attributes on the row element (`data-key`, `data-entity`…), which drags and drops find rows by. */
  readonly attrs?: Readonly<Record<string, string | number>>;
  readonly title?: string;
  /** Drawn before the name. */
  readonly icon?: ComponentChildren;
  /** Drawn after the name (badges, toggles). */
  readonly trailing?: ComponentChildren;
  /** The drop indicator a drag over this row asks for. */
  readonly drop?: "into" | "before" | "after" | null;
  /** The row is being dragged. */
  readonly dragging?: boolean;
  /** Open or close it (the caret, Left, Right). */
  setOpen(open: boolean): void;
  /** A click or arrow key picked it. */
  select(how: TreeSelect): void;
  /** Right-click at a page point. */
  menu?(x: number, y: number): void;
  /** Double-click on it. */
  activate?(): void;
  /** Renaming in place (F2, or `renameRow`); absent or null when it can't be renamed now. */
  readonly rename?: TreeRename | null;
  /** The Delete key on it. */
  remove?(): void;
  /** A primary-button press on it: the adapter's drag starts here (`pointerDrag.ts`). */
  drag?(e: PointerEvent): void;
}

/** The row being renamed in a tree, and in which view of it (its `owner`; null: every view of the tree shows it). */
interface Renaming {
  readonly key: string;
  readonly view: object | null;
}

const renamings = new Map<string, Signal<Renaming | null>>();
const renamingIn = (tree: string): Signal<Renaming | null> => {
  let s = renamings.get(tree);
  if (!s) renamings.set(tree, (s = signal<Renaming | null>(null)));
  return s;
};

/**
 * Start renaming the row `key` of the tree named `tree` (a menu's Rename); it shows if that row has a `rename`. With
 * `owner`, only in the tree view given that owner (one panel of several showing the tree).
 */
export function renameRow(tree: string, key: string, owner?: object): void {
  renamingIn(tree).value = { key, view: owner ?? null };
}

/** A visible row with where it sits. */
interface Placed {
  readonly row: TreeRow;
  readonly depth: number;
  readonly parent: Placed | null;
}

function visibleRows(rows: readonly TreeRow[]): Placed[] {
  const out: Placed[] = [];
  const walk = (level: readonly TreeRow[], depth: number, parent: Placed | null) => {
    for (const row of level) {
      const placed = { row, depth, parent };
      out.push(placed);
      if (row.expandable && row.open && row.children) walk(row.children, depth + 1, placed);
    }
  };
  walk(rows, 0, null);
  return out;
}

export interface TreeViewProps {
  /** The tree's name, for `renameRow` ("hierarchy", "live", "folders"). */
  readonly tree: string;
  /** The tree's accessible name. */
  readonly label: string;
  readonly rows: readonly TreeRow[];
  /** The list's classes beside `tree-view` (default `tree`, the Hierarchy's, which many rules and selectors name). */
  readonly class?: string;
  /** More than one row can be selected. */
  readonly multiselectable?: boolean;
  /** Indent per level, in pixels. */
  readonly indent?: number;
  /** Who this view belongs to (its panel's view state), for `renameRow`'s `owner`. */
  readonly owner?: object;
}

/** Each tree's id prefix for its rows' label ids. */
let treeViewIds = 0;

export function TreeView(props: TreeViewProps) {
  const { rows, indent = 14 } = props;
  const ownView = useRef({}).current;
  const view = props.owner ?? ownView;
  const elements = useRef(new Map<string, HTMLElement>()).current;
  // Each item is named by its own row (`aria-labelledby`), not by its content: an open folder's name would hold every row
  // under it (the ARIA name of a treeitem comes from all its text, its group's included).
  const idBase = useRef(`tree-${++treeViewIds}`).current;
  let rowIndex = 0;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const renaming = renamingIn(props.tree);
  const current = renaming.value;
  const flat = visibleRows(rows);
  const visible = flat.map((p) => p.row.key);
  // One tab stop: the row last focused, else the first selected one, else the first.
  const stop = flat.find((p) => p.row.key === focusKey) ?? flat.find((p) => p.row.selected) ?? flat[0];

  const focusRow = (key: string) => {
    setFocusKey(key);
    elements.get(key)?.focus();
  };
  const pick = (p: Placed | undefined) => {
    if (!p) return;
    p.row.select({ toggle: false, range: false, visible });
    focusRow(p.row.key);
  };
  const startRename = (row: TreeRow) => {
    if (row.rename) renaming.value = { key: row.key, view };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, button")) return;
    const item = target.closest<HTMLElement>("[role=treeitem]");
    const at = flat.findIndex((p) => elements.get(p.row.key) === item);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const p = flat[at]!;
    switch (e.key) {
      case "ArrowDown": pick(flat[at + 1]); break;
      case "ArrowUp": pick(flat[at - 1]); break;
      case "Home": pick(flat[0]); break;
      case "End": pick(flat[flat.length - 1]); break;
      case "ArrowRight":
        if (p.row.expandable && !p.row.open) p.row.setOpen(true);
        else if (p.row.expandable && flat[at + 1]?.parent === p) pick(flat[at + 1]);
        break;
      case "ArrowLeft":
        if (p.row.expandable && p.row.open) p.row.setOpen(false);
        else pick(p.parent ?? undefined);
        break;
      case "F2":
        if (!p.row.rename) return;
        startRename(p.row);
        break;
      case "Delete":
      case "Backspace":
        if (!p.row.remove || e.shiftKey) return;
        p.row.remove();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation(); // the tree's own keys, not the editor's shortcuts
  };

  const renderRow = (row: TreeRow, depth: number): ComponentChildren => {
    const isRenaming = !!current && current.key === row.key && (current.view === null || current.view === view) && !!row.rename;
    const classes = ["row", row.className, row.selected && "selected", row.drop && `drop-${row.drop}`, row.dragging && "dragging"].filter(Boolean).join(" ");
    const endRename = () => {
      if (renaming.peek()?.key === row.key) renaming.value = null;
    };
    const labelId = `${idBase}-${rowIndex++}`;
    return (
      <li
        key={row.key}
        role="treeitem"
        aria-labelledby={labelId}
        aria-level={depth + 1}
        aria-selected={row.selected}
        aria-expanded={row.expandable ? row.open : undefined}
        tabIndex={stop?.row === row ? 0 : -1}
        ref={(el) => {
          if (el) elements.set(row.key, el);
          else if (elements.get(row.key)?.isConnected === false) elements.delete(row.key);
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusKey(row.key);
        }}
      >
        <div
          id={labelId}
          class={classes}
          {...row.attrs}
          style={{ paddingLeft: `${depth * indent + 4}px` }}
          title={row.title}
          onPointerDown={(e) => {
            if (!isRenaming) row.drag?.(e);
          }}
          onClick={(e) => row.select({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey, visible })}
          onDblClick={() => row.activate?.()}
          onContextMenu={(e) => {
            if (!row.menu) return;
            e.preventDefault();
            e.stopPropagation();
            row.menu(e.clientX, e.clientY);
          }}
        >
          <span
            class={`caret${row.expandable ? (row.open ? " open" : "") : " leaf"}`}
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              if (row.expandable) row.setOpen(!row.open);
            }}
          />
          {row.icon}
          {isRenaming ? (
            <RenameField
              value={row.rename!.value}
              label={row.rename!.label}
              placeholder={row.rename!.placeholder}
              selectTo={row.rename!.selectTo}
              onCommit={(value) => {
                endRename();
                row.rename!.commit(value);
              }}
              onCancel={() => {
                endRename();
                row.rename!.cancel?.();
              }}
              onKeyboardEnd={() => elements.get(row.key)?.focus()}
            />
          ) : (
            <span class="name">{row.label}</span>
          )}
          {row.trailing}
        </div>
        {row.expandable && row.open && row.children && <ul role="group">{row.children.map((c) => renderRow(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <ul class={`tree-view ${props.class ?? "tree"}`} role="tree" aria-label={props.label} aria-multiselectable={props.multiselectable || undefined} onKeyDown={onKeyDown}>
      {rows.map((r) => renderRow(r, 0))}
    </ul>
  );
}
