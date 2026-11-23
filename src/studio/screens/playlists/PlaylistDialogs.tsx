// The Playlists screen's dialogs: the delete confirmation with the prototype's choices (PL:1430–1459: children "move
// them up" or "delete all N inside"; links "unlink copies" or "remove from all"), and the folder delete's (W2.14:
// what's inside moves up a level). Both can be undone.
import { useEffect, useRef, useState } from "preact/hooks";
import { playlistTitle } from "./playlistPaths";
import type { ChildrenChoice, DeletePlan, LinksChoice } from "./structureEdits";

export interface DeleteDialogProps {
  readonly plan: DeletePlan;
  onConfirm(children: ChildrenChoice, links: LinksChoice): void;
  onCancel(): void;
}

/** The delete confirmation's wording for a plan: where children go up to, and the summary line. */
function deleteWording(plan: DeletePlan): { up: string; summary: string } {
  const file = plan.target.kind === "file";
  return {
    up: file ? "Keep them: each embedded one becomes a playlist file in the same folder" : "Move them up to the parent playlist",
    summary: "You can undo this.",
  };
}

export function DeleteDialog(props: DeleteDialogProps) {
  const { plan } = props;
  const [children, setChildren] = useState<ChildrenChoice>("up");
  const [links, setLinks] = useState<LinksChoice>("unlink");
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  const w = deleteWording(plan);
  return (
    <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="pl-dialog" role="alertdialog" aria-modal="true" aria-label={`Delete ${plan.name}?`} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        <h2 class="pl-dialog-title">Delete {plan.name}?</h2>
        <p class="pl-note">{w.summary}</p>
        {plan.children > 0 && (
          <fieldset class="pl-choice">
            <legend>It holds {plan.children === 1 ? "1 playlist" : `${plan.children} playlists`}</legend>
            <label><input type="radio" name="pl-children" checked={children === "up"} onChange={() => setChildren("up")} /> {w.up}</label>
            <label><input type="radio" name="pl-children" checked={children === "all"} onChange={() => setChildren("all")} /> Delete all {plan.children} inside</label>
          </fieldset>
        )}
        {plan.linkedBy.length > 0 && (
          <fieldset class="pl-choice">
            <legend>{plan.linkedBy.length === 1 ? "1 playlist links it" : `${plan.linkedBy.length} playlists link it`}: {plan.linkedBy.map(playlistTitle).join(", ")}</legend>
            <label><input type="radio" name="pl-links" checked={links === "unlink"} onChange={() => setLinks("unlink")} /> Unlink the copies (each keeps its own playlist)</label>
            <label><input type="radio" name="pl-links" checked={links === "remove"} onChange={() => setLinks("remove")} /> Remove it from all of them</label>
          </fieldset>
        )}
        <div class="pl-dialog-foot">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" ref={confirm} class="pl-danger-btn" onClick={() => props.onConfirm(children, links)}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export interface FolderDeleteDialogProps {
  /** The folder, how many items move up, and the folder they move to ("" the top level). */
  readonly folder: { readonly path: string; readonly items: number; readonly to: string };
  onConfirm(): void;
  onCancel(): void;
}

/** "Delete folder?": what's inside moves up a level, so nothing is lost; Undo puts it back. */
export function FolderDeleteDialog(props: FolderDeleteDialogProps) {
  const { path, items, to } = props.folder;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  const where = to ? to.slice(to.lastIndexOf("/") + 1) : "the top level";
  const moves = items === 0 ? "It's empty." : `${items === 1 ? "1 item moves" : `${items} items move`} to ${where}.`;
  return (
    <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="pl-dialog" role="alertdialog" aria-modal="true" aria-label={`Delete folder ${name}?`} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        <h2 class="pl-dialog-title">Delete folder “{name}”?</h2>
        <p class="pl-note">{moves} You can undo this.</p>
        <div class="pl-dialog-foot">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" ref={confirm} class="pl-danger-btn" onClick={props.onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}
