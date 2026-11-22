// The Playlists screen's dialogs: the delete confirmation with the prototype's choices (PL:1430–1459: children "move
// them up" or "delete all N inside"; links "unlink copies" or "remove from all"), and the voice-curves placeholder that
// `openCurveEditor` opens until the shared curve editor merges (it lists the entry's curves and can clear one).
import { useEffect, useRef, useState } from "preact/hooks";
import type { VoiceCurveTarget } from "../../../engine/audio/playlist/types";
import { CURVE_TARGET_TEXT, type CurveEditorRequest } from "./curveEditorAdapter";
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
    summary: file ? `${playlistTitle(plan.target.kind === "file" ? plan.target.path : "")} is deleted from disk; this can't be undone.` : "You can undo this.",
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

/** Until the shared curve editor (ADR 0332) merges: what curves an entry has, and clearing one. */
export function CurvePlaceholder(props: { readonly request: CurveEditorRequest; onClose(): void }) {
  const { request } = props;
  const targets = Object.keys(CURVE_TARGET_TEXT) as VoiceCurveTarget[];
  return (
    <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="pl-dialog" role="dialog" aria-modal="true" aria-label={request.title} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 class="pl-dialog-title">{request.title}</h2>
        <p class="pl-note">The shared curve editor opens here once it lands. Voice curves shape gain, pitch, pan and filters over voice time or a parameter{request.drivers.length ? ` (${request.drivers.join(", ")})` : ""}.</p>
        <ul class="pl-curves">
          {targets.map((t) => {
            const c = request.curves[t];
            return (
              <li key={t}>
                <span>{CURVE_TARGET_TEXT[t]}</span>
                <span class="pl-row-meta">{c ? `${c.curve.length} keys over ${typeof c.input === "string" ? "voice time" : c.input.parameter}${c.bypass ? " · bypassed" : ""}` : "none"}</span>
                {c && (
                  <button type="button" class="pl-small" onClick={() => {
                    const next = { ...request.curves };
                    delete next[t];
                    request.apply(next, `Clear ${CURVE_TARGET_TEXT[t].replace(/ \(.*\)$/, "").toLowerCase()} automation`);
                    props.onClose();
                  }}>Clear</button>
                )}
              </li>
            );
          })}
        </ul>
        <div class="pl-dialog-foot">
          <button type="button" autoFocus onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
