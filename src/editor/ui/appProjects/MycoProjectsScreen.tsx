// Myco Engine's projects screen (ADR 0380; the "Myco Engine · Projects" artboard): the Myco logo beside a Projects tab
// (`ProjectsTab`) and a Samples tab, the samples that ship beside the editor (ADR 0031) to open read-only or, where
// folders open, copy into a folder to edit. The desktop launcher shows it after Open on the Myco Engine card.
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { launcherArt, PRODUCT_NAME, VERSION } from "../../brand";
import { canOpenFolders } from "../../projectFs";
import { listSamples, type SampleInfo } from "../../samples";
import { startActions } from "../../startActions";
import { AppProjectsLayout } from "./AppProjectsLayout";
import { ProjectsTab } from "./ProjectsTab";
import { ProjectTabs, TabPanel } from "./ProjectTabs";

type Tab = "projects" | "samples";

const tab = signal<Tab>("projects");
/** The samples served beside the editor, once listed (null while loading). */
const samples = signal<SampleInfo[] | null>(null);
/** The sample being opened or copied, so its buttons say so. */
const busy = signal<string | null>(null);

const sizeOf = (s: SampleInfo) => {
  const bytes = s.files.reduce((n, f) => n + f.size, 0);
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

async function run(id: string, action: () => Promise<unknown>): Promise<void> {
  busy.value = id;
  try {
    await action();
  } finally {
    busy.value = null;
  }
}

function SamplesTab() {
  const list = samples.value;
  const desktop = canOpenFolders();
  if (list === null) return <p class="ap-note">Looking for samples…</p>;
  if (list.length === 0) return <p class="ap-note">No samples ship with this editor.</p>;
  return (
    <div class="ap-stack ap-tight">
      <p class="ap-note">Open a sample to explore it, or make a copy to change it freely.</p>
      <ul class="ap-samples" aria-label="Samples">
        {list.map((s) => (
          <li key={s.id} class="ap-sample">
            <div class="ap-sample-head">
              <h3 class="ap-sample-name">{s.name}</h3>
              <span class="ap-meta">
                {s.files.length} files · {sizeOf(s)}
              </span>
            </div>
            {s.description && <p class="ap-clamp ap-muted">{s.description}</p>}
            <div class="ap-sample-actions">
              <button type="button" class="ap-button" disabled={busy.value !== null} title={`Open ${s.name} read-only`} onClick={() => void run(s.id, () => startActions().open({ kind: "sample", sample: s }))}>
                {busy.value === s.id ? "Opening…" : "Open"}
              </button>
              {desktop && (
                <button type="button" class="ap-button" disabled={busy.value !== null} title={`Copy ${s.name} into a folder and open the copy to edit it`} onClick={() => void run(s.id, () => startActions().open({ kind: "copy-sample", sample: s }))}>
                  Make a Copy…
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface MycoProjectsScreenProps {
  /** Back to the Foxfire launcher. */
  readonly back?: () => void;
  readonly chrome?: ComponentChildren;
  /** The footer's status line while there's no message. */
  readonly note?: string;
}

export function MycoProjectsScreen(props: MycoProjectsScreenProps) {
  useEffect(() => {
    if (samples.value === null) void listSamples().then((list) => (samples.value = list));
  }, []);
  const tabs = [
    { id: "projects" as const, label: "Projects" },
    { id: "samples" as const, label: "Samples", ...(samples.value ? { badge: samples.value.length } : {}) },
  ];
  return (
    <AppProjectsLayout app={PRODUCT_NAME} logo={launcherArt.mycoSplash} tagline="2D & 3D game engine and editor" back={props.back} footer={`${PRODUCT_NAME} ${VERSION}`} note={props.note} chrome={props.chrome}>
      <ProjectTabs tabs={tabs} selected={tab.value} onSelect={(id) => (tab.value = id)} label="Project screen" idPrefix="myco" />
      <TabPanel idPrefix="myco" id={tab.value}>
        {tab.value === "projects" ? <ProjectsTab /> : <SamplesTab />}
      </TabPanel>
    </AppProjectsLayout>
  );
}
