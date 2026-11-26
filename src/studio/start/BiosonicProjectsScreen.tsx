// Biosonic's projects screen (ADR 0380; the "Biosonic · Projects" artboard): the Biosonic logo beside a Live session
// bar, a Projects tab (the editor's `ProjectsTab`, over the shared recent projects) and a Recorded takes tab (the
// takes in the recent project folders, `recentTakes.ts`). The desktop launcher shows it after Open on the Biosonic
// card; the Studio shows it when no project is open (the standalone app, `studio.html` in a browser).
//
// Live session: Connect to Game… opens the debug link's Connect dialog (ADR 0403) through `onConnect`: the Studio's own
// start screen opens it over the Studio's link, the launcher hands it to the Studio window (which holds the link, so the
// connection outlives the launcher). It stays disabled where a page passes none. `connected` names the build the
// Studio is connected to; its screens (Take, Profiler, Mixer) work with it once a project is open.
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AUDIO_APP_NAME, launcherArt, VERSION } from "../../editor/brand";
import { canOpenFolders, projectFileSystem } from "../../editor/projectFs";
import { recentProjects } from "../../editor/recentProjects";
import { AppProjectsLayout } from "../../editor/ui/appProjects/AppProjectsLayout";
import { openedWhen, searchRows } from "../../editor/ui/appProjects/appProjectsLogic";
import { ProjectsTab } from "../../editor/ui/appProjects/ProjectsTab";
import { ProjectTabs, TabPanel } from "../../editor/ui/appProjects/ProjectTabs";
import { Chip } from "../../editor/ui/Chip";
import { ContextMenu, type MenuEntry } from "../../editor/ui/ContextMenu";
import { confirmInEditor } from "../../editor/ui/ConfirmDialog";
import { status } from "../../editor/state";
import { errorStatus } from "../../editor/messages";
import { addedTakes, forgetTake, takesFolder } from "../takesFolder";
import { formatTakeLength, listAllTakes, readTakeSummary, type RecentTake } from "./recentTakes";
import { TakesFolderLine } from "./TakesFolderLine";
import "./biosonic.css";

type Tab = "projects" | "takes";

const tab = signal<Tab>("projects");

/** Shows the Recorded takes tab (the launcher does it after take files are dropped on it). */
export function showRecordedTakes(): void {
  tab.value = "takes";
}

/** The takes found in the recent projects, the takes folder and the added files (null until listed; listed again when any of them changes). */
const takes = signal<RecentTake[] | null>(null);
let listedFor = "";

async function listTakes(key: string): Promise<void> {
  if (key === listedFor && takes.value !== null) return;
  listedFor = key;
  takes.value = null;
  const fs = await projectFileSystem();
  const list = fs ? await listAllTakes(recentProjects().list(), takesFolder.peek(), addedTakes.peek(), fs, readTakeSummary) : [];
  if (listedFor === key) takes.value = list;
}

const takeKey = (t: RecentTake) => t.file.toLowerCase();

/** Delete a take's file and its notes from disk, after asking (it can't be undone), then list the takes again. */
async function deleteTake(t: RecentTake): Promise<void> {
  const where = t.kind === "project" ? `from ${t.project.name}` : "from disk";
  const { ok } = await confirmInEditor({
    title: `Delete ${t.name}?`,
    message: `The take file and its notes are deleted ${where}. This can't be undone.`,
    items: [t.file],
    confirmLabel: "Delete",
  });
  if (!ok) return;
  try {
    const fs = await projectFileSystem();
    if (!fs) throw new Error("this window can't reach the file system");
    await fs.remove(t.file);
    const notes = `${t.file}.notes.json`;
    if (await fs.exists(notes).catch(() => false)) await fs.remove(notes);
    forgetTake(t.file);
    status.value = { kind: "info", text: `Deleted ${t.name}` };
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${t.name}`, err);
  }
  listedFor = ""; // list again: the file is gone
  await listTakes(`deleted:${t.file}`);
}

/** The take's badge: "Project" (beside its project's name) or "Recording" (a take outside any project). */
function TakeBadge(props: { readonly take: RecentTake }) {
  return props.take.kind === "project" ? <Chip>Project</Chip> : <Chip tone="accent">Recording</Chip>;
}

const recorded = (t: RecentTake) => (t.recordedMs === null ? "date unknown" : openedWhen(t.recordedMs));

function TakesTab(props: { readonly onOpenTake?: (take: RecentTake) => void }) {
  const version = recentProjects().version.value;
  const folder = takesFolder.value;
  const key = `${version}:${recentProjects().list().map((e) => e.id).join()}:${folder ?? ""}:${addedTakes.value.join("|")}`;
  useEffect(() => void listTakes(key).catch((err) => (console.warn("[biosonic] couldn't list the recorded takes:", err), (takes.value = []))), [key]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ take: RecentTake; at: Element } | null>(null);
  const list = takes.value;
  const open = props.onOpenTake;
  const openTake = (t: RecentTake) => {
    if (!open) return;
    setBusy(takeKey(t));
    Promise.resolve(open(t)).finally(() => setBusy(null));
  };
  const found = list ? searchRows(list, query, (t) => ({ name: t.name, where: `${t.kind === "project" ? t.project.name : "recording"} ${t.file}` })) : [];
  const searching = query.trim() !== "";
  const [latest, ...rest] = found;
  const listed = searching ? found : rest;
  const moreButton = (t: RecentTake) => (
    <button type="button" class="ap-more" aria-label={`More actions for ${t.name}`} aria-haspopup="menu" onClick={(ev) => setMenu({ take: t, at: ev.currentTarget })}>
      ⋯
    </button>
  );
  const openButton = (t: RecentTake, cls: string) => (
    <button type="button" class={cls} aria-label={`Open take ${t.name}`} disabled={!open || busy !== null} title={open ? (t.kind === "project" ? `Open ${t.path} in ${t.project.name}` : `Open ${t.file}`) : "Takes open in the desktop app"} onClick={() => openTake(t)}>
      {busy === takeKey(t) ? "Opening…" : "Open Take"}
    </button>
  );

  const menuEntries = (t: RecentTake): MenuEntry[] => [
    { kind: "group", label: t.file },
    {
      id: "reveal",
      label: "Open Folder Location",
      run: () =>
        void projectFileSystem()
          .then((fs) => fs?.reveal?.(t.file))
          .catch((err) => console.warn("[biosonic] couldn't reveal the take:", err)),
    },
    ...(t.kind === "recording" && addedTakes.value.some((p) => p.toLowerCase() === t.file.toLowerCase()) ? [{ id: "forget", label: "Remove from list", title: "The file stays where it is", run: () => forgetTake(t.file) }] : []),
    { kind: "separator" },
    { id: "delete", label: "Delete…", danger: true, title: "Delete the take file and its notes from disk", run: () => void deleteTake(t) },
  ];

  return (
    <div class="ap-stack">
      <div class="ap-toolbar">
        <p class="ap-note">Open a take from your recent projects or the takes folder. Drop a .sporesample file here to add it.</p>
        <div class="ap-searchwrap">
          <input class="ap-search" type="search" placeholder="Search takes" aria-label="Search takes" value={query} disabled={!list || list.length === 0} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </div>
      <div class="ap-scroll">
        {!canOpenFolders() ? (
          <p class="ap-note">Takes are listed from project folders, which this browser can't open.</p>
        ) : list === null ? (
          <p class="ap-note">Looking for takes…</p>
        ) : list.length === 0 ? (
          <p class="ap-note">No takes yet. Record one from the editor's Play toolbar (Record take) or a live session, or drop a .sporesample file on this window.</p>
        ) : (
          <>
            {!searching && latest && (
              <section class="ap-section" aria-labelledby="bs-latest-heading">
                <h2 id="bs-latest-heading" class="ap-heading">
                  Latest take
                </h2>
                <div class="ap-hero">
                  <div class="ap-hero-text">
                    <p class="ap-hero-name">{latest.name}</p>
                    <p class="ap-meta">
                      <TakeBadge take={latest} /> {latest.kind === "project" ? `From ${latest.project.name}` : "Not in a project"}
                    </p>
                    <p class="ap-meta">
                      <span class="ap-mono">{formatTakeLength(latest.seconds)}</span> · Recorded {recorded(latest)}
                    </p>
                  </div>
                  {openButton(latest, "ap-primary ap-big")}
                  {moreButton(latest)}
                </div>
              </section>
            )}
            {(listed.length > 0 || searching) && (
              <section class="ap-section" aria-labelledby="bs-takes-heading">
                <div class="ap-heading-row">
                  <h2 id="bs-takes-heading" class="ap-heading">
                    {searching ? "Matching takes" : "All takes"}
                  </h2>
                  <span class="ap-meta">{searching ? `${listed.length} found` : "Most recent first"}</span>
                </div>
                {listed.length === 0 ? (
                  <p class="ap-note">No take matches “{query.trim()}”.</p>
                ) : (
                  <ul class="ap-rows" aria-label="Recorded takes">
                    {listed.map((t) => (
                      <li key={takeKey(t)} class="ap-row">
                        <div class="ap-row-text">
                          <span class="ap-row-name">{t.name}</span>
                          <span class="ap-meta ap-ellipsis" title={t.file}>
                            <TakeBadge take={t} /> {t.kind === "project" ? t.project.name : t.path}
                          </span>
                        </div>
                        <span class="ap-row-meta">
                          <span class="ap-mono">{formatTakeLength(t.seconds)}</span> · {recorded(t)}
                        </span>
                        {openButton(t, "ap-button")}
                        {moreButton(t)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {menu && <ContextMenu entries={menuEntries(menu.take)} at={menu.at} label={`${menu.take.name} menu`} class="bs-take-menu" onClose={() => setMenu(null)} />}
    </div>
  );
}

export interface BiosonicProjectsScreenProps {
  /** Back to the Foxfire launcher (absent in the Studio's own start). */
  readonly back?: () => void;
  readonly chrome?: ComponentChildren;
  /** The footer's status line while there's no message. */
  readonly note?: string;
  /** Open a recorded take (its project, on the Take screen); absent where takes can't be opened. */
  readonly onOpenTake?: (take: RecentTake) => void | Promise<void>;
  /** Open the Connect dialog for a running debug build; absent where the page can't (the button stays disabled). */
  readonly onConnect?: () => void;
  /** The connected build's name, shown in the Live session bar (absent or null: none, or the page can't tell). */
  readonly connected?: string | null;
}

export function BiosonicProjectsScreen(props: BiosonicProjectsScreenProps) {
  const tabs = [
    { id: "projects" as const, label: "Projects" },
    { id: "takes" as const, label: "Recorded takes" },
  ];
  return (
    <AppProjectsLayout app={AUDIO_APP_NAME} logo={launcherArt.biosonicLogo} tagline="Audio design studio for games" back={props.back} footer={`${AUDIO_APP_NAME} ${VERSION}`} note={props.note} chrome={props.chrome}>
      <section class="bs-live ap-pad" aria-labelledby="bs-live-heading">
        <div class="bs-live-text">
          <h2 id="bs-live-heading" class="bs-live-heading">
            Live session
          </h2>
          <p class="bs-live-copy" role="status">
            {props.connected ? `Connected to ${props.connected}.` : "Connect to a running debug build of your game to record takes and profile its audio."}
          </p>
          <TakesFolderLine />
        </div>
        <button type="button" class="bs-live-button" disabled={!props.onConnect} title={props.onConnect ? "Connect by the code the game shows, its address, or a build found on your network" : "Connecting needs the Audio Studio"} onClick={props.onConnect}>
          {props.connected ? "Connect Another…" : "Connect to Game…"}
        </button>
      </section>
      <ProjectTabs tabs={tabs} selected={tab.value} onSelect={(id) => (tab.value = id)} label="Project screen" idPrefix="biosonic" />
      <TabPanel idPrefix="biosonic" id={tab.value}>
        {tab.value === "projects" ? <ProjectsTab /> : <TakesTab onOpenTake={props.onOpenTake} />}
      </TabPanel>
    </AppProjectsLayout>
  );
}
