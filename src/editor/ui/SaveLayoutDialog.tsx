// Save Layout As… (ADR 0174): a name, and where to keep the layout: for you (per-user storage), in
// the project (`.layouts/<name>.layout.json`, shared through version control), or both.
import { useEffect, useRef, useState } from "preact/hooks";
import { saveLayoutAsOpen } from "../layout/layoutDialogs";
import { fileNameFor, LAYOUTS_FOLDER, type LayoutScope } from "../layout/saved";
import { activeSaved, savedLayouts, saveLayoutAs, whyNoProjectLayouts } from "../layout/savedStore";

export function SaveLayoutDialog() {
  const open = saveLayoutAsOpen.value;
  const [name, setName] = useState("");
  const [user, setUser] = useState(true);
  const [project, setProject] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const noProject = whyNoProjectLayouts();
  useEffect(() => {
    if (!open) return;
    setName(activeSaved.peek() ? `${activeSaved.peek()!.name} copy` : "");
    setUser(true);
    setProject(false);
    queueMicrotask(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open]);
  if (!open) return null;
  const scopes: LayoutScope[] = [...(user ? (["user"] as const) : []), ...(project && !noProject ? (["project"] as const) : [])];
  const trimmed = name.trim();
  const file = trimmed ? fileNameFor(trimmed, new Set(savedLayouts.value.map((s) => s.file))) : null;
  const canSave = trimmed !== "" && scopes.length > 0;
  const close = (save: boolean) => {
    saveLayoutAsOpen.value = false;
    if (save && canSave) void saveLayoutAs(trimmed, scopes);
  };
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        class="dialog save-layout-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-layout-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close(false);
          } else if (e.key === "Enter" && canSave) {
            e.preventDefault();
            close(true);
          }
        }}
      >
        <h2 id="save-layout-title">Save layout</h2>
        <label class="layout-name-field">
          Name
          <input ref={input} type="text" aria-label="Layout name" placeholder="Level design" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <fieldset class="layout-scopes">
          <legend>Keep it</legend>
          <label title="In your own settings, for every project">
            <input type="checkbox" checked={user} onChange={(e) => setUser((e.currentTarget as HTMLInputElement).checked)} />
            For me
          </label>
          <label title={noProject ?? `In ${LAYOUTS_FOLDER}/, so everyone with the project gets it`}>
            <input type="checkbox" checked={project && !noProject} disabled={noProject !== null} onChange={(e) => setProject((e.currentTarget as HTMLInputElement).checked)} />
            In the project
          </label>
        </fieldset>
        <p class="layout-file-preview" aria-live="polite">
          {scopes.length === 0 ? "Choose where to keep it." : file ? `${project && !noProject ? `${LAYOUTS_FOLDER}/` : ""}${file}` : " "}
          {noProject && <span class="layout-scope-note"> Project layouts: {noProject}.</span>}
        </p>
        <div class="dialog-buttons">
          <button onClick={() => close(false)}>Cancel</button>
          <button class="primary" disabled={!canSave} onClick={() => close(true)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
