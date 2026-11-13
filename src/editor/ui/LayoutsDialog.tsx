// Manage Layouts (ADR 0174): the saved layouts; for the selected one, rename, where it's kept
// (for me / in the project), delete, and its versions as an undo tree (`UndoTree`): Apply shows a
// version without changing the layout; Restore makes it the layout's current version.
import { useEffect, useState } from "preact/hooks";
import { manageLayoutsOpen } from "../layout/layoutDialogs";
import { LAYOUTS_FOLDER, scopeLabel, scopesOf, type LayoutScope } from "../layout/saved";
import { activeLayoutFile, applySavedLayout, deleteLayout, renameLayout, restoreLayoutVersion, savedLayouts, setLayoutScopes, whyNoProjectLayouts } from "../layout/savedStore";
import { confirmInEditor } from "./ConfirmDialog";
import { UndoTree } from "./undoTree/UndoTree";

export function LayoutsDialog() {
  const open = manageLayoutsOpen.value;
  const list = savedLayouts.value;
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setSelected(activeLayoutFile.peek() ?? savedLayouts.peek()[0]?.file ?? null);
  }, [open]);
  const layout = list.find((s) => s.file === selected) ?? list[0] ?? null;
  useEffect(() => {
    setName(layout?.name ?? "");
    setPicked(layout?.newest.head ?? null);
  }, [layout?.file, layout?.name, layout?.newest.head]);
  if (!open) return null;
  const close = () => (manageLayoutsOpen.value = false);
  const noProject = whyNoProjectLayouts();
  const scopes = layout ? scopesOf(layout) : [];
  const setScope = (scope: LayoutScope, on: boolean) => {
    if (!layout) return;
    const next = on ? [...new Set([...scopes, scope])] : scopes.filter((s) => s !== scope);
    if (next.length > 0) void setLayoutScopes(layout.file, next);
  };
  const file = layout?.newest;
  const states = file ? file.versions.map((v) => ({ seq: v.seq, parent: v.parent, label: v.label, time: v.savedAt })) : [];
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog layouts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="layouts-title"
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest("input")) e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <h2 id="layouts-title">Layouts</h2>
        {!layout ? (
          <p>No saved layouts yet. Use Layouts › Save Layout As… to save the panels as they are.</p>
        ) : (
          <div class="layouts-body">
            <ul class="layouts-list" role="listbox" aria-label="Saved layouts">
              {list.map((s) => (
                <li key={s.file} role="option" aria-selected={s.file === layout.file} class={s.file === layout.file ? "selected" : ""} onClick={() => setSelected(s.file)} title={s.file}>
                  <span class="layouts-name">{s.name}</span>
                  <span class="layouts-scope">{scopeLabel(scopesOf(s))}</span>
                </li>
              ))}
            </ul>
            <div class="layouts-detail">
              <label class="layout-name-field">
                Name
                <input
                  type="text"
                  aria-label="Layout name"
                  value={name}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === "Enter" && void renameLayout(layout.file, name)}
                  onBlur={() => void renameLayout(layout.file, name)}
                />
              </label>
              <fieldset class="layout-scopes">
                <legend>Kept</legend>
                <label>
                  <input type="checkbox" checked={scopes.includes("user")} disabled={scopes.length === 1 && scopes[0] === "user"} onChange={(e) => setScope("user", (e.currentTarget as HTMLInputElement).checked)} />
                  For me
                </label>
                <label title={noProject ?? `${LAYOUTS_FOLDER}/${layout.file}`}>
                  <input
                    type="checkbox"
                    checked={scopes.includes("project")}
                    disabled={noProject !== null || (scopes.length === 1 && scopes[0] === "project")}
                    onChange={(e) => setScope("project", (e.currentTarget as HTMLInputElement).checked)}
                  />
                  In the project
                </label>
              </fieldset>
              <p class="layouts-hint">Versions: each save adds one; nothing is lost when you restore an older one and save again.</p>
              <div class="layouts-versions">
                <UndoTree
                  states={states}
                  current={picked ?? undefined}
                  marked={file!.head}
                  markLabel="current"
                  markTitle="The version this layout means now"
                  label={`Versions of ${layout.name}`}
                  scrollKey={layout.file}
                  onPick={setPicked}
                />
              </div>
              <div class="layouts-actions">
                <button disabled={picked === null} onClick={() => picked !== null && applySavedLayout(layout.file, picked)} title="Show this version without changing the layout">
                  Apply
                </button>
                <button disabled={picked === null || picked === file!.head} onClick={() => picked !== null && void restoreLayoutVersion(layout.file, picked)} title="Make this version the layout's current one, and show it">
                  Restore
                </button>
                <span class="asset-spacer" />
                <button
                  class="danger"
                  onClick={async () => {
                    const answer = await confirmInEditor({ title: `Delete ${layout.name}`, message: `Delete the layout “${layout.name}” and all its versions (${scopeLabel(scopes)})?`, confirmLabel: "Delete" });
                    if (answer.ok) await deleteLayout(layout.file);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
        <div class="dialog-buttons">
          <button class="primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
