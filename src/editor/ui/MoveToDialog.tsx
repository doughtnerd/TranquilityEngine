// The Move to… dialog (ADR 0349): pick a folder for one or more files or folders, in a `KitDialog` titled
// "Move “name” to". The project's folders as a tree (`TreeView`, every folder open to start) or, while searching, the
// matching folders by path, always with the top level first; the folder the items are in ("here now") and a moved
// folder with everything inside it are disabled, with why (`moveToModel.ts`). A click on an allowed folder moves
// there (so do Enter, a double-click, or Move); Escape, ×, Cancel or a click outside cancels.
import { fileName } from "../projectPath";
import { useMemo, useState } from "preact/hooks";
import { KitDialog } from "./KitDialog";
import { folderTree, isCurrentFolder, searchFolders, whyNotMoveTo, type FolderNode, type MovingItem } from "./moveToModel";
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
  /** The root's name (default "Top level"). */
  readonly rootName?: string;
  /** The moving item's name for the title (default: the last part of its path). */
  readonly itemName?: string;
  /** The whole title instead of "Move “name” to". */
  readonly title?: string;
  onMove(folder: string): void;
  onCancel(): void;
}


export function MoveToDialog(props: MoveToDialogProps) {
  const { items, folders, onMove, onCancel } = props;
  const rootName = props.rootName ?? "Top level";
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => folderTree(folders, rootName), [folders, rootName]);
  const why = (path: string) => whyNotMoveTo(path, items);
  const blocked = choice === null ? "Pick a folder" : why(choice);
  const move = (path: string | null) => {
    if (path !== null && why(path) === null) onMove(path);
  };
  const noun = props.noun ?? "item";
  const title = props.title ?? (items.length === 1 ? `Move “${props.itemName ?? fileName(items[0].path)}” to` : `Move ${items.length} ${noun}s to`);
  const here = (path: string) => (isCurrentFolder(path, items) ? <span class="kit-move-here">here now</span> : undefined);

  const row = (node: FolderNode): TreeRow => {
    const reason = why(node.path);
    return {
      key: node.path || "/",
      label: node.name,
      className: reason ? "kit-move-disabled" : undefined,
      title: reason ?? (node.path || rootName),
      expandable: node.children.length > 0,
      open: !closed.has(node.path),
      children: node.children.map(row),
      selected: choice === node.path,
      trailing: here(node.path),
      attrs: { "aria-disabled": reason ? "true" : "false", "data-move-path": node.path },
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
    <KitDialog
      class="kit-move-dialog"
      title={title}
      onClose={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target as HTMLElement).closest?.("button")) {
          e.preventDefault();
          move(choice ?? (matches?.find((m) => why(m) === null) ?? null));
        }
      }}
      summary={choice !== null && blocked ? <span class="kit-move-why">{blocked}</span> : undefined}
      buttons={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button class="primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => move(choice)}>
            Move
          </button>
        </>
      }
    >
      <input class="kit-move-search" type="search" placeholder="Search folders" aria-label="Search folders" value={query} autoFocus onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      <div
        class="kit-move-list"
        onClick={(e) => {
          // One click on an allowed folder moves there (the caret only opens and closes).
          const el = (e.target as HTMLElement).closest?.("[data-move-path]");
          if (el) move(el.getAttribute("data-move-path"));
        }}
      >
        {matches === null ? (
          <TreeView tree="move-to" label="Folders" rows={[row(tree)]} />
        ) : (
          <ul class="kit-move-matches" role="listbox" aria-label="Matching folders">
            {matches.map((path) => {
              const reason = why(path);
              return (
                <li key={path || "/"} role="option" aria-selected={choice === path} aria-disabled={!!reason} data-move-path={path} class={`${choice === path ? "selected " : ""}${reason ? "kit-move-disabled" : ""}`} title={reason ?? (path || rootName)}>
                  <span class="kit-move-path">{path || rootName}</span>
                  {here(path)}
                </li>
              );
            })}
            {matches.length === 1 && <li class="kit-move-none" role="presentation">No other folder matches “{query.trim()}”.</li>}
          </ul>
        )}
      </div>
    </KitDialog>
  );
}
