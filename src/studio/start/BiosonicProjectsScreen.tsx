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
import { formatTakeLength, listRecentTakes, readTakeSummary, type RecentTake } from "./recentTakes";
import "./biosonic.css";

type Tab = "projects" | "takes";

const tab = signal<Tab>("projects");
/** The takes found in the recent projects (null until listed; listed again when the list of projects changes). */
const takes = signal<RecentTake[] | null>(null);
let listedFor = "";

async function listTakes(key: string): Promise<void> {
  if (key === listedFor && takes.value !== null) return;
  listedFor = key;
  takes.value = null;
  const fs = await projectFileSystem();
  const list = fs ? await listRecentTakes(recentProjects().list(), fs, readTakeSummary) : [];
  if (listedFor === key) takes.value = list;
}

const recorded = (t: RecentTake) => (t.recordedMs === null ? "date unknown" : openedWhen(t.recordedMs));

function TakesTab(props: { readonly onOpenTake?: (take: RecentTake) => void }) {
  const version = recentProjects().version.value;
  const key = `${version}:${recentProjects().list().map((e) => e.id).join()}`;
  useEffect(() => void listTakes(key).catch((err) => (console.warn("[biosonic] couldn't list the recorded takes:", err), (takes.value = []))), [key]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const list = takes.value;
  const open = props.onOpenTake;
  const openTake = (t: RecentTake) => {
    if (!open) return;
    setBusy(t.path + t.project.id);
    Promise.resolve(open(t)).finally(() => setBusy(null));
  };
  const found = list ? searchRows(list, query, (t) => ({ name: t.name, where: `${t.project.name} ${t.path}` })) : [];
  const searching = query.trim() !== "";
  const [latest, ...rest] = found;
  const listed = searching ? found : rest;
  const openButton = (t: RecentTake, cls: string) => (
    <button type="button" class={cls} aria-label={`Open take ${t.name}`} disabled={!open || busy !== null} title={open ? `Open ${t.path} in ${t.project.name}` : "Takes open in the desktop app"} onClick={() => openTake(t)}>
      {busy === t.path + t.project.id ? "Opening…" : "Open Take"}
    </button>
  );

  return (
    <div class="ap-stack">
      <div class="ap-toolbar">
        <p class="ap-note">Open a take straight from any of your recent projects.</p>
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
          <p class="ap-note">No takes yet. Record one from the editor's Play toolbar (Record take), and it shows here.</p>
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
                    <p class="ap-meta">From {latest.project.name}</p>
                    <p class="ap-meta">
                      <span class="ap-mono">{formatTakeLength(latest.seconds)}</span> · Recorded {recorded(latest)}
                    </p>
                  </div>
                  {openButton(latest, "ap-primary ap-big")}
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
                      <li key={t.project.id + t.path} class="ap-row">
                        <div class="ap-row-text">
                          <span class="ap-row-name">{t.name}</span>
                          <span class="ap-meta ap-ellipsis" title={t.path}>
                            {t.project.name}
                          </span>
                        </div>
                        <span class="ap-row-meta">
                          <span class="ap-mono">{formatTakeLength(t.seconds)}</span> · {recorded(t)}
                        </span>
                        {openButton(t, "ap-button")}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
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
            {props.connected ? `Connected to ${props.connected}. Open a project to record takes from it.` : "Connect to a running debug build of your game to record takes and profile its audio."}
          </p>
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
