// The Captures panel's view (ADR 0348; the prototype's captures tree): the project's capture files by folder in the
// editor's `TreeView` (or, while searching, the matches by path), a search field, Open capture file… (copies files
// into the project's captures folder), and per capture Open, Rename (F2), Move to… and Delete (Del) through a context
// menu. The empty state says where captures come from. A view over props: the panel wires the engine's asset actions.
import { useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { TreeView, renameRow, type TreeRow } from "../../../editor/ui/TreeView";
import { Icon } from "../../components/Icon";
import { captureTree, isCapturePath, NO_CAPTURES, searchCaptures, type CaptureNode } from "./captureTree";

export interface CaptureListProps {
  /** Every project file (capture files are picked out). */
  readonly files: readonly string[];
  /** Every project folder (Move to… lists them). */
  readonly folders: readonly string[];
  /** The capture open on the timeline. */
  readonly openPath: string | null;
  /** Files can be written (a folder project): import, rename, move and delete are offered. */
  readonly writable: boolean;
  onOpen(path: string): void;
  onImport(files: readonly File[]): void;
  onRename(path: string, name: string): void;
  onMove(path: string, folder: string): void;
  onDelete(path: string): void;
}

const TREE = "profiler-captures";

export function CaptureList(props: CaptureListProps) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const tree = useMemo(() => captureTree(props.files), [props.files]);
  const any = props.files.some(isCapturePath);

  const fileRow = (path: string, label: string): TreeRow => ({
    key: path,
    label,
    expandable: false,
    open: false,
    selected: path === props.openPath,
    attrs: { "data-capture": path },
    title: path,
    icon: <Icon name={path.toLowerCase().endsWith(".mycotake") ? "take" : "profiler"} size={14} class="pf-file-icon" />,
    setOpen: () => {},
    select: () => props.onOpen(path),
    activate: () => props.onOpen(path),
    menu: (x, y) => setMenu({ path, x, y }),
    rename: props.writable ? { value: label, label: "Capture name", selectTo: label.lastIndexOf(".") > 0 ? label.lastIndexOf(".") : undefined, commit: (v) => v.trim() && v !== label && props.onRename(path, v.trim()) } : null,
    ...(props.writable ? { remove: () => props.onDelete(path) } : {}),
  });
  const row = (n: CaptureNode): TreeRow =>
    n.kind === "file"
      ? fileRow(n.path, n.name)
      : {
          key: `folder:${n.path}`,
          label: n.name,
          expandable: true,
          open: !closed.has(n.path),
          selected: false,
          icon: <Icon name="folder" size={14} class="pf-file-icon" />,
          children: n.children.map(row),
          setOpen: (open) => {
            const next = new Set(closed);
            if (open) next.delete(n.path);
            else next.add(n.path);
            setClosed(next);
          },
          select: () => {},
        };

  const entries = (path: string): MenuEntry[] => [
    { id: "open", label: "Open", run: () => props.onOpen(path) },
    SEPARATOR,
    { id: "rename", label: "Rename", hint: "F2", disabled: !props.writable, run: () => renameRow(TREE, path) },
    { id: "move", label: "Move to…", disabled: !props.writable, run: () => setMoving(path) },
    SEPARATOR,
    { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: !props.writable, run: () => props.onDelete(path) },
  ];
  const matches = query.trim() ? searchCaptures(props.files, query) : null;

  return (
    <div class="pf-captures">
      <div class="pf-captures-tools">
        <input type="search" class="pf-search" placeholder="Search captures" aria-label="Search captures" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button type="button" class="pf-tool" disabled={!props.writable} title={props.writable ? "Copy a capture file into this project's captures folder" : "This project is read-only"} onClick={() => input.current?.click()}>
          <Icon name="import" size={14} /> Open capture file…
        </button>
        <input
          ref={input}
          type="file"
          accept=".mycap,.mycotake"
          multiple
          hidden
          aria-label="Capture files to import"
          onChange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const files = [...(el.files ?? [])];
            el.value = "";
            if (files.length) props.onImport(files);
          }}
        />
      </div>
      {!any ? (
        <EmptyState compact title="No captures yet" body={NO_CAPTURES.replace(/^No captures yet — /, "")} />
      ) : matches ? (
        matches.length === 0 ? (
          <p class="pf-note">No capture matches “{query.trim()}”.</p>
        ) : (
          <TreeView tree={TREE} label="Matching captures" rows={matches.map((p) => fileRow(p, p))} />
        )
      ) : (
        <TreeView tree={TREE} label="Captures" rows={tree.map(row)} />
      )}
      {menu && <ContextMenu entries={entries(menu.path)} at={{ x: menu.x, y: menu.y }} label="Capture menu" onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={[{ path: moving, folder: false }]}
          folders={props.folders}
          noun="capture"
          onMove={(folder) => {
            props.onMove(moving, folder);
            setMoving(null);
          }}
          onCancel={() => setMoving(null)}
        />
      )}
    </div>
  );
}
