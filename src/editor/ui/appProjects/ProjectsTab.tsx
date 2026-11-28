// The Projects tab of an application's projects screen (ADR 0380), the same in Myco Engine and Biosonic: New
// Project…, Add from Folder…, a search over the recent projects, the newest as "Continue where you left off" and the
// rest under "All projects", each with Open and a ⋯ menu (Remove from List; Edit location note for a browser folder,
// whose real path a browser can't see, ADR 0116). The list is the shared recent projects (`recentProjects()`); each
// entry is checked when the tab shows, and a missing folder can't be opened: its Open becomes Remove from List.
// Removing only takes the entry off the list (the folder stays), says so in a toast with Undo, and moves focus to the
// next project's ⋯ (or the toolbar when none is left); the card under "Continue where you left off" then shows the
// next most recent project, or goes. Opening goes through `startActions()`, which the page sets for its app.
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { NO_FOLDERS_NOTE, canOpenFolders, projectFileSystem } from "../../projectFs";
import { locationOf, recentProjects, type RecentProject, type RecentState } from "../../recentProjects";
import { startActions } from "../../startActions";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { openNewProjectDialog } from "../NewProjectDialog";
import { UndoToasts, createToastQueue } from "../UndoToast";
import { openedWhen, removeFromList, searchRows, splitLatest } from "./appProjectsLogic";

/** Each recent project's state, checked when the tab shows (by entry id). */
const states = signal<ReadonlyMap<string, RecentState>>(new Map());
/** The entry being opened, so its buttons say so and the others wait. */
const busy = signal<string | null>(null);
/** "Removed … from the list · Undo". */
const toasts = createToastQueue();

async function checkAll(list: readonly RecentProject[]): Promise<void> {
  const fs = await projectFileSystem();
  const out = new Map<string, RecentState>();
  await Promise.all(list.map(async (e) => out.set(e.id, await recentProjects().check(e, fs))));
  states.value = out;
}

const STATE_NOTE: Partial<Record<RecentState, string>> = { missing: "Missing", "needs-access": "Asks for access" };

async function reopen(entry: RecentProject): Promise<void> {
  busy.value = entry.id;
  try {
    await startActions().open({ kind: "recent", entry });
  } finally {
    busy.value = null;
  }
}

const searchText = (e: RecentProject) => ({ name: e.name, where: locationOf(e) });

const REMOVE_TITLE = "Take it off this list. The folder and its files stay on disk.";

export function ProjectsTab() {
  const version = recentProjects().version.value;
  const can = canOpenFolders();
  const all = can ? recentProjects().list() : [];
  const ids = all.map((e) => e.id).join();
  useEffect(() => void checkAll(all), [ids, version]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ entry: RecentProject; at: Element } | null>(null);
  const [labelling, setLabelling] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const found = searchRows(all, query, searchText);
  const searching = query.trim() !== "";
  const { latest, rest } = splitLatest(found, (e) => e.lastOpened);
  const listed = searching ? (latest ? [latest, ...rest] : []) : rest;
  const stateOf = (e: RecentProject) => states.value.get(e.id) ?? "unknown";

  /** Take `entry` off the list, then focus the ⋯ of the project now in its place (or the one before; the toolbar when none is left). */
  const forget = async (entry: RecentProject) => {
    const mores = () => [...(root.current?.querySelectorAll<HTMLButtonElement>(".ap-more") ?? [])];
    const at = mores().findIndex((b) => b.dataset.entry === entry.id);
    if (!(await removeFromList(recentProjects(), entry, toasts))) return;
    requestAnimationFrame(() => {
      const left = mores();
      const next = left[Math.min(Math.max(at, 0), left.length - 1)] ?? root.current?.querySelector<HTMLButtonElement>(".ap-toolbar button:not(:disabled)");
      next?.focus();
    });
  };

  const menuEntries = (entry: RecentProject): MenuEntry[] => [
    ...(entry.kind === "handle" ? [{ id: "label", label: "Edit Location Note…", title: "Note where this folder is (browsers can't show its path)", run: () => setLabelling(entry.id) }] : []),
    { id: "remove", label: "Remove from List", detail: "The folder stays on disk", title: REMOVE_TITLE, run: () => void forget(entry) },
  ];

  const moreButton = (e: RecentProject) => (
    <button type="button" class="ap-more" data-entry={e.id} aria-label={`More actions for ${e.name}`} aria-haspopup="menu" title="More actions" onClick={(ev) => setMenu({ entry: e, at: ev.currentTarget })}>
      ⋯
    </button>
  );
  /** A missing project's one action: take it off the list. */
  const removeButton = (e: RecentProject, cls: string) => (
    <button type="button" class={cls} aria-label={`Remove ${e.name} from the list`} title={`${locationOf(e)} is gone (or no longer has a project.json). ${REMOVE_TITLE}`} onClick={() => void forget(e)}>
      Remove from List
    </button>
  );

  /** A browser folder's location note, typed in place after Edit Location Note…. */
  const labelInput = (e: RecentProject) =>
    labelling === e.id && (
      <input
        class="ap-label-input"
        type="text"
        aria-label={`Location note for ${e.name}`}
        placeholder="e.g. ~/games/flappy"
        value={e.label ?? ""}
        maxLength={200}
        ref={(el) => el?.focus()}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") setLabelling(null);
          if (ev.key === "Enter") ev.currentTarget.blur();
        }}
        onBlur={(ev) => {
          recentProjects().setLabel(e.id, ev.currentTarget.value);
          setLabelling(null);
        }}
      />
    );

  return (
    <div class="ap-stack" ref={root}>
      <div class="ap-toolbar">
        <button type="button" class="ap-primary" disabled={!can} onClick={openNewProjectDialog}>
          New Project…
        </button>
        <button type="button" class="ap-button" disabled={!can} onClick={() => void startActions().open({ kind: "pick-folder" })}>
          Add from Folder…
        </button>
        <div class="ap-searchwrap">
          <input class="ap-search" type="search" placeholder="Search projects" aria-label="Search projects" value={query} disabled={all.length === 0} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </div>
      <div class="ap-scroll">
        {!can && <p class="ap-note">{NO_FOLDERS_NOTE}</p>}
        {can && all.length === 0 && <p class="ap-note">No projects yet. Make a new one, or add a project folder you already have.</p>}

        {!searching && latest && (
          <section class="ap-section" aria-labelledby="ap-recent-heading">
            <h2 id="ap-recent-heading" class="ap-heading">
              Continue where you left off
            </h2>
            <div class="ap-hero" data-state={stateOf(latest)}>
              <div class="ap-hero-text">
                <p class="ap-hero-name">{latest.name}</p>
                <p class="ap-path ap-wrap">{locationOf(latest)}</p>
                <p class="ap-meta">
                  {STATE_NOTE[stateOf(latest)] ? <span class={`ap-state ${stateOf(latest)}`}>{STATE_NOTE[stateOf(latest)]}</span> : `Opened ${openedWhen(latest.lastOpened)}`}
                </p>
              </div>
              {stateOf(latest) === "missing" ? (
                removeButton(latest, "ap-button ap-big")
              ) : (
                <button type="button" class="ap-primary ap-big" aria-label={`Open ${latest.name}`} disabled={busy.value !== null} onClick={() => void reopen(latest)}>
                  {busy.value === latest.id ? "Opening…" : "Open"}
                </button>
              )}
              {moreButton(latest)}
              {labelInput(latest)}
            </div>
          </section>
        )}

        {(listed.length > 0 || searching) && (
          <section class="ap-section" aria-labelledby="ap-all-heading">
            <div class="ap-heading-row">
              <h2 id="ap-all-heading" class="ap-heading">
                {searching ? "Matching projects" : "All projects"}
              </h2>
              <span class="ap-meta">{searching ? `${listed.length} found` : "Most recent first"}</span>
            </div>
            {listed.length === 0 ? (
              <p class="ap-note">No recent project matches “{query.trim()}”.</p>
            ) : (
              <ul class="ap-rows" aria-label="Recent projects">
                {listed.map((e) => {
                  const state = stateOf(e);
                  return (
                    <li key={e.id} class={`ap-row${state === "missing" ? " missing" : ""}`} data-state={state}>
                      <div class="ap-row-text">
                        <span class="ap-row-name">{e.name}</span>
                        <span class="ap-path ap-ellipsis" title={e.kind === "handle" ? "A browser can't see a folder's real path; this is its name or your note." : e.path}>
                          {locationOf(e)}
                        </span>
                      </div>
                      <span class="ap-row-meta">{STATE_NOTE[state] ? <span class={`ap-state ${state}`}>{STATE_NOTE[state]}</span> : busy.value === e.id ? "Opening…" : openedWhen(e.lastOpened)}</span>
                      {state === "missing" ? (
                        removeButton(e, "ap-button")
                      ) : (
                        <button type="button" class="ap-button" aria-label={`Open ${e.name}`} title={`Open ${e.name}`} disabled={busy.value !== null} onClick={() => void reopen(e)}>
                          Open
                        </button>
                      )}
                      {moreButton(e)}
                      {labelInput(e)}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
      {menu && <ContextMenu entries={menuEntries(menu.entry)} at={menu.at} label={`${menu.entry.name} menu`} onClose={() => setMenu(null)} />}
      <UndoToasts queue={toasts} />
    </div>
  );
}
