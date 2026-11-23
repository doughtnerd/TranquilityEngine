// The Move to… dialog (ADR 0349): pick a folder for one or more files or folders. The project's folders as a tree
// (`TreeView`, every folder open to start) or, while searching, the matching folders by path; the folder the items
// are in and a moved folder with everything inside it are disabled, with why (`moveToModel.ts`). Move (or Enter, or
// a double-click) confirms; Escape, Cancel or a click outside cancels.
import { useMemo, useState } from "preact/hooks";
import { folderTree, searchFolders, whyNotMoveTo, type FolderNode, type MovingItem } from "./moveToModel";
import { TreeView, type TreeRow } from "./TreeView";
import "./kit.css";

export type { MovingItem } from "./moveToModel";

export interface MoveToDialogProps {
  /** What is moving. */
  readonly items: readonly MovingItem[];
  /** Every folder in the project (project-relative, `/`). */
  readonly folders: readonly string[];
  /** What the items are, for the title ("sample", "take"); default "item". */
  readonly noun?: string;
  /** The root's name (default "Project"). */
  readonly rootName?: string;
  onMove(folder: string): void;
  onCancel(): void;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function MoveToDialog(props: MoveToDialogProps) {
  const { items, folders, onMove, onCancel } = props;
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => folderTree(folders, props.rootName ?? "Project"), [folders, props.rootName]);
  const why = (path: string) => whyNotMoveTo(path, items);
  const blocked = choice === null ? "Pick a folder" : why(choice);
  const move = (path: string | null) => {
    if (path !== null && why(path) === null) onMove(path);
  };
  const noun = props.noun ?? "item";
  const title = items.length === 1 ? `Move ${nameOf(items[0].path)} to…` : `Move ${items.length} ${noun}s to…`;

  const row = (node: FolderNode): TreeRow => {
    const reason = why(node.path);
    return {
      key: node.path || "/",
      label: node.name,
      className: reason ? "kit-move-disabled" : undefined,
      title: reason ?? (node.path || props.rootName || "Project"),
      expandable: node.children.length > 0,
      open: !closed.has(node.path),
      children: node.children.map(row),
      selected: choice === node.path,
      attrs: { "aria-disabled": reason ? "true" : "false" },
      setOpen: (open) => {
        const next = new Set(closed);
        if (open) next.delete(node.path);
        else next.add(node.path);
        setClosed(next);
      },
      select: () => setChoice(node.path),
      activate: () => move(node.path),
    };
  };
  const matches = query.trim() ? searchFolders(folders, query) : null;

  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        class="dialog kit-move-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !(e.target as HTMLElement).closest?.("button")) {
            e.preventDefault();
            move(choice ?? (matches?.find((m) => why(m) === null) || null));
          }
        }}
      >
        <h2>{title}</h2>
        <input class="kit-move-search" type="search" placeholder="Search folders" aria-label="Search folders" value={query} autoFocus onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <div class="kit-move-list">
          {matches === null ? (
            <TreeView tree="move-to" label="Folders" rows={[row(tree)]} />
          ) : matches.length === 0 ? (
            <p class="kit-move-none">No folder matches “{query.trim()}”.</p>
          ) : (
            <ul class="kit-move-matches" role="listbox" aria-label="Matching folders">
              {matches.map((path) => {
                const reason = why(path);
                return (
                  <li key={path} role="option" aria-selected={choice === path} aria-disabled={!!reason} class={`${choice === path ? "selected " : ""}${reason ? "kit-move-disabled" : ""}`} title={reason ?? path} onClick={() => setChoice(path)} onDblClick={() => move(path)}>
                    {path}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div class="dialog-buttons">
          {choice !== null && blocked && <span class="kit-move-why">{blocked}</span>}
          <button onClick={onCancel}>Cancel</button>
          <button class="primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => move(choice)}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
