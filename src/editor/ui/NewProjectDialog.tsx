import { signal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { FileSystem } from "../../engine/platform/FileSystem";
import { describeError } from "../messages";
import { PROJECT_TEMPLATES, whyNotProjectName, type ProjectTemplate } from "../newProject";
import { joinPath } from "../projectPaths";
import { startActions } from "../startActions";
import "./projects.css";

const open = signal(false);
/** The last folder a project was created in, offered again this session. */
let lastLocation: { fs: FileSystem; path: string } | null = null;

type Location = { fs: FileSystem; path: string };
// The form lives here, not in the component: the editor replaces the start-screen shell with the full
// App while the dialog may already be open, remounting the component, and component-local state (reset
// on mount) would wipe what was typed in the meantime.
const nameField = signal("");
const templateField = signal<ProjectTemplate>("2d");
const locationField = signal<Location | null>(null);
const errorField = signal<string | null>(null);
const busyField = signal(false);

/** Show the New Project dialog, with a blank form. */
export function openNewProjectDialog(): void {
  if (open.value) return;
  nameField.value = "";
  templateField.value = "2d";
  locationField.value = lastLocation;
  errorField.value = null;
  busyField.value = false;
  open.value = true;
}

/** New Project (ADR 0038): a name, a template and a parent folder; Create makes the project's folder there and opens it. */
export function NewProjectDialog() {
  const input = useRef<HTMLInputElement>(null);
  const name = nameField.value;
  const template = templateField.value;
  const location = locationField.value;
  const error = errorField.value;
  const busy = busyField.value;
  const setName = (v: string) => (nameField.value = v);
  const setTemplate = (v: ProjectTemplate) => (templateField.value = v);
  const setLocation = (v: Location | null) => (locationField.value = v);
  const setError = (v: string | null) => (errorField.value = v);
  const setBusy = (v: boolean) => (busyField.value = v);
  useLayoutEffect(() => {
    if (open.value) input.current?.focus();
  }, [open.value]);
  if (!open.value) return null;

  const problem = name.trim() ? whyNotProjectName(name) : null;
  const canCreate = !busy && name.trim() !== "" && problem === null && location !== null;
  const close = () => {
    if (!busy) open.value = false;
  };
  const choose = async () => {
    const picked = await startActions().pickProjectLocation();
    if (picked) {
      setLocation(picked);
      setError(null);
      lastLocation = picked;
    }
  };
  const create = async () => {
    if (!canCreate || !location) return;
    setBusy(true);
    setError(null);
    try {
      await startActions().createProject(location.fs, location.path, name, template);
      open.value = false;
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog new-project"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onKeyDown={(e) => {
          e.stopPropagation(); // keep editor shortcuts out while typing
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" && canCreate && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            void create();
          }
        }}
      >
        <h2 id="new-project-title">New project</h2>
        <label class="new-project-field">
          Name
          <input ref={input} type="text" aria-label="Project name" placeholder="My Game" value={name} onInput={(e) => (setName((e.currentTarget as HTMLInputElement).value), setError(null))} />
        </label>
        <fieldset class="new-project-templates">
          <legend>Template</legend>
          {PROJECT_TEMPLATES.map((t) => (
            <label key={t.id} title={t.hint}>
              <input type="radio" name="project-template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span class="new-project-template-name">{t.label}</span>
              <span class="new-project-template-hint">{t.hint}</span>
            </label>
          ))}
        </fieldset>
        <div class="new-project-field">
          Location
          <div class="new-project-location">
            <span class="new-project-path" title={location?.path}>
              {location ? location.path : "No folder chosen"}
            </span>
            <button onClick={() => void choose()} disabled={busy}>
              Choose…
            </button>
          </div>
        </div>
        <p class={`new-project-preview${problem || error ? " problem" : ""}`} aria-live="polite">
          {error ?? problem ?? (location && name.trim() ? `Creates ${joinPath(location.path, name.trim())}` : "The project gets its own folder inside the location.")}
        </p>
        <div class="dialog-buttons">
          <button onClick={close} disabled={busy}>
            Cancel
          </button>
          <button class="primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
