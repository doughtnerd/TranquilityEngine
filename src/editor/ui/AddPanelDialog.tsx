// The Add Panel dialog (ADR 0174): a checklist of every panel type. Types already open say so and
// add another copy; a single-copy panel (the Scene view) is offered only when it isn't open. OK adds
// one of each ticked type, into the header's group when opened from a header menu, else to each
// panel's usual place; the last one added shows.
import { useEffect, useRef, useState } from "preact/hooks";
import { allPanels, instancesOf, isSinglePanel, panelTitle, type PanelId } from "../layout/model";
import { addPanelRequest, addPanels, layout } from "../layout/store";

export function AddPanelDialog() {
  const request = addPanelRequest.value;
  const [ticked, setTicked] = useState<ReadonlySet<PanelId>>(new Set());
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTicked(new Set());
    first.current?.focus();
  }, [request]);
  if (!request) return null;
  const current = layout.value;
  const types = allPanels().filter((t) => !(isSinglePanel(t) && instancesOf(current, t).length > 0));
  const close = (add: boolean) => {
    addPanelRequest.value = null;
    if (add && ticked.size > 0) addPanels(types.filter((t) => ticked.has(t)), request.group);
  };
  const toggle = (t: PanelId, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(t);
    else next.delete(t);
    setTicked(next);
  };
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        class="dialog add-panel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-panel-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            close(true);
          }
        }}
      >
        <h2 id="add-panel-title">Add panels</h2>
        <p>{request.group ? "The panels you tick are added to this group." : "The panels you tick are added beside their usual neighbours."}</p>
        <ul class="add-panel-list" aria-label="Panels">
          {types.map((t, i) => {
            const open = instancesOf(current, t).length;
            const id = `add-panel-${t}`;
            return (
              <li key={t}>
                <input id={id} ref={i === 0 ? first : undefined} type="checkbox" data-panel-type={t} checked={ticked.has(t)} onChange={(e) => toggle(t, (e.currentTarget as HTMLInputElement).checked)} />
                <label for={id}>
                  {panelTitle(t)}
                  {open > 0 && <span class="add-panel-note">{open === 1 ? "open (adds another)" : `${open} open (adds another)`}</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <div class="dialog-buttons">
          <button onClick={() => close(false)}>Cancel</button>
          <button class="primary" disabled={ticked.size === 0} onClick={() => close(true)}>
            {ticked.size > 1 ? `Add ${ticked.size} panels` : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
