import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { NO_FOLDERS_NOTE, canOpenFolders, projectFileSystem } from "../projectFs";
import { recentProjects, recentVersion, type RecentProject, type RecentState } from "../recentProjects";
import { startActions } from "../startActions";
import { openNewProjectDialog } from "./NewProjectDialog";
import "./projects.css";

/** Each recent project's state, checked when the start screen shows (by entry id). */
const states = signal<ReadonlyMap<string, RecentState>>(new Map());
const busy = signal<string | null>(null);

async function checkAll(list: readonly RecentProject[]): Promise<void> {
  const fs = await projectFileSystem();
  const out = new Map<string, RecentState>();
  await Promise.all(list.map(async (e) => out.set(e.id, await recentProjects().check(e, fs))));
  states.value = out;
}

const STATE_NOTE: Record<RecentState, string | null> = {
  ok: null,
  missing: "Missing",
  "needs-access": "Asks for access",
  unknown: null,
};

const when = (time: number) => {
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
};

/**
 * The start screen's projects (ADR 0038): New Project…, Open Project… and the recent projects.
 * Where folders can't be opened (Safari, Firefox in a browser) it says so instead.
 */
export function StartProjects() {
  recentVersion.value;
  const can = canOpenFolders();
  const list = can ? recentProjects().list() : [];
  const ids = list.map((e) => e.id).join();
  useEffect(() => void checkAll(list), [ids, recentVersion.value]);

  const reopen = async (entry: RecentProject) => {
    busy.value = entry.id;
    try {
      await startActions().openRecentProject(entry);
    } finally {
      busy.value = null;
    }
  };
  const forget = async (entry: RecentProject) => {
    await recentProjects().remove(entry.id);
    recentVersion.value++;
  };

  return (
    <section class="start-projects" aria-label="Projects">
      <h2>Projects</h2>
      <div class="start-project-buttons">
        <button class="primary" disabled={!can} onClick={openNewProjectDialog}>
          New Project…
        </button>
        <button disabled={!can} onClick={() => void startActions().openProjectFolder()}>
          Open Project…
        </button>
      </div>
      {!can && <p class="start-note">{NO_FOLDERS_NOTE}</p>}
      {list.length > 0 && (
        <>
          <h3 class="start-subhead">Recent</h3>
          <ul class="recent-list" aria-label="Recent projects">
            {list.map((e) => {
              const state = states.value.get(e.id) ?? "unknown";
              const note = STATE_NOTE[state];
              return (
                <li key={e.id} class={`recent${state === "missing" ? " missing" : ""}`} data-state={state}>
                  <button
                    class="recent-open"
                    disabled={busy.value !== null || state === "missing"}
                    title={state === "missing" ? `${e.path} is gone (or no longer has a project.json)` : `Open ${e.name} (${e.path})`}
                    onClick={() => void reopen(e)}
                  >
                    <span class="recent-name">{e.name}</span>
                    <span class="recent-path">{e.path}</span>
                  </button>
                  <span class="recent-meta">
                    {note && <span class={`recent-state ${state}`}>{note}</span>}
                    <span class="recent-time">{busy.value === e.id ? "Opening…" : when(e.lastOpened)}</span>
                  </span>
                  <button class="recent-remove" aria-label={`Remove ${e.name} from recent projects`} title="Remove from this list (the folder stays)" onClick={() => void forget(e)}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
