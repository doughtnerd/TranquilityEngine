// The Packages screen (ADR 0337 §6; Wwise's SoundBank Manager, FMOD's Banks tab): the package list (left), the fixed
// panel with its Contents, Profiles and rules, and Report tabs, the package inspector (right) and History. Every edit is
// a step of `audio.json`'s document history (`applyEdit` over `openMixDocument`); the panels carry `data-asset-document`
// so Ctrl+Z and the History panel act on it. A package rename also rewrites `AudioPackageLoader` fields in scenes and
// prefabs, and a profile rename the sidecars choosing it, through the editor's project file edits.
import type { ComponentChildren } from "preact";
import { editProjectFiles } from "../../../editor/projectFileEdits";
import type { EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { audioDependencies } from "../../../engine/audio/packaging/definitions";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import { applyEdit, type EditResult } from "../../../plugins/audio/editor/editResult";
import type { SourceFacts } from "../../encoding/estimate";
import { convertProjectNow, projectPlanSource } from "../../encoding/studioEncoding";
import { configOf, studioPlan } from "../../encoding/studioPlan";
import type { StudioPlanSource } from "../../encoding/studioPlan";
import type { StudioPanel } from "../../shell/studioPanels";
import { openRoute } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { historyPanel } from "../placeholder";
import { peaksOf } from "../samples/sampleSession";
import { ContentsView, type SoundFigures } from "./ContentsView";
import { PackageInspectorView } from "./PackageInspectorView";
import { PackageListView } from "./PackageListView";
import {
  addPackage, addToPackage, defsOf, deletePackage, lintPackageNames, looseAssets, packageList, packageRenameEdit, packageView, removeFromPackage, removeInclude, renamePackage,
  setPreload, setShipsOn, setStrict, strictOf,
} from "./packagesModel";
import { converting, exactReports, packagesPlatform, packagesTab, selectedPackage, selectedProfile, type PackagesTab } from "./packagesState";
import {
  addProfile, addRule, deleteProfile, moveRule, profileRenameEdit, removeRule, renameProfile, rulePreview, setBudget, setDefaultProfile, setProfileKey, updateRule,
} from "./profilesModel";
import { ProfilesView, type ProfileScope } from "./ProfilesView";
import { estimatedReport, exactReport, type PlatformReport } from "./reportModel";
import { ReportView } from "./ReportView";
import { persisted } from "../../../editor/preferences";
import "../samples/samples.css";
import "./packages.css";

const profileScope = persisted<ProfileScope>("myco.studio.packages.profileScope", "all");

/** What every panel reads: the project, `audio.json`'s document and value, the plan source and dependencies. */
function screen() {
  const project = currentProject.value;
  const doc = openMixDocument(project);
  if (!project || !doc) return null;
  const audio = doc.value.value;
  const source: StudioPlanSource = projectPlanSource(project);
  const json = (p: string) => (project.assets.has(p) ? project.assets.get(p) : undefined);
  const deps = audioDependencies(json);
  const commit = (result: EditResult<AudioProject>, label: string) => applyEdit(result, label, (next) => doc.edit(next, { label }), doc.value.peek());
  return { project, doc, audio, source, deps, commit, readOnly: doc.readOnly };
}

const facts = (project: EditorProject) => (path: string): SourceFacts => {
  const peaks = peaksOf(project, path);
  return { bytes: project.sizeOf(path) ?? 0, frames: peaks?.frames ?? null, rate: peaks?.rate ?? null, channels: peaks?.channels ?? null };
};

/** The report for `platform`: Convert now's while `audio.json` hasn't changed since, else the estimate. */
function reportFor(s: NonNullable<ReturnType<typeof screen>>, platform: ImportPlatform): PlatformReport {
  const exact = exactReports.value.get(platform);
  if (exact && exact.against === s.audio) return exactReport(exact.report, configOf(s.audio));
  return estimatedReport(studioPlan(s.source, platform), facts(s.project));
}

function Doc(props: { children: ComponentChildren }) {
  return <div class="pk-doc" data-asset-document={AUDIO_PROJECT_FILE}>{props.children}</div>;
}

function noProject() {
  return <Panel bodyClass="studio-panel-body"><EmptyState compact title="No project" body="Open a project to define its packages." /></Panel>;
}

function renamePackageEverywhere(s: NonNullable<ReturnType<typeof screen>>, from: string, to: string): void {
  if (!s.commit(renamePackage(s.audio, from, to), `Rename package ${from} to ${to}`)) return;
  if (selectedPackage.peek() === from) selectedPackage.value = to;
  void editProjectFiles(s.project, packageRenameEdit(from, to), `Rename package ${from} to ${to}`).then((changed) => {
    if (changed.length > 0) status.value = { kind: "info", text: `Renamed ${from} to ${to} in ${changed.length} scene${changed.length === 1 ? "" : "s"} and prefab${changed.length === 1 ? "" : "s"}.` };
  });
}

function ListPanel() {
  const s = screen();
  if (!s) return noProject();
  const rows = packageList(s.audio, s.project.files, s.deps, packagesPlatform.value);
  const selected = selectedPackage.value ?? rows[0]?.name ?? null;
  return (
    <Panel bodyClass="studio-panel-body">
      <Doc>
        <PackageListView
          rows={rows}
          selected={selected}
          platform={packagesPlatform.value}
          readOnly={s.readOnly}
          onSelect={(n) => (selectedPackage.value = n)}
          onAdd={() => {
            const r = addPackage(s.audio);
            if (s.commit(r, "New package") && "next" in r) selectedPackage.value = defsOf(r.next).at(-1)!.name;
          }}
          onRename={(from, to) => renamePackageEverywhere(s, from, to)}
          onDelete={(n) => s.commit(deletePackage(s.audio, n), `Delete package ${n}`)}
          onDropSound={(n, p) => s.commit(addToPackage(s.audio, n, p), `Add ${p} to ${n}`)}
        />
      </Doc>
    </Panel>
  );
}

const open = (path: string) => openRoute({ screen: path.toLowerCase().endsWith(".playlist.json") ? "playlists" : "samples", asset: path });

function ContentsTab(s: NonNullable<ReturnType<typeof screen>>) {
  const defs = defsOf(s.audio);
  const name = selectedPackage.value ?? defs[0]?.name ?? null;
  const view = name ? packageView(s.audio, name, s.project.files, s.deps) : null;
  const report = reportFor(s, packagesPlatform.value);
  const bySound = new Map(report.sounds.map((x) => [x.path, x]));
  const figures = (path: string): SoundFigures | null => {
    const x = bySound.get(path);
    return x ? { profile: x.profile, codec: x.codec, load: x.load, bytes: x.bytes, memoryBytes: x.memoryBytes, exact: report.exact } : null;
  };
  const refusal = (path: string) => {
    if (!view) return null;
    const r = removeFromPackage(s.audio, view.def.name, path, { files: s.project.files, deps: s.deps });
    return "refused" in r ? r.refused : null;
  };
  return (
    <ContentsView
      view={view}
      loose={looseAssets(s.audio, s.project.files, s.deps)}
      packages={defs.map((d) => d.name)}
      figures={figures}
      removeRefusal={refusal}
      readOnly={s.readOnly}
      onAdd={(pkg, p) => s.commit(addToPackage(s.audio, pkg, p), `Add ${p} to ${pkg}`)}
      onRemove={(pkg, p) => s.commit(removeFromPackage(s.audio, pkg, p, { files: s.project.files, deps: s.deps }), `Remove ${p} from ${pkg}`)}
      onRemoveInclude={(pkg, inc) => s.commit(removeInclude(s.audio, pkg, inc), `Remove ${inc} from ${pkg}`)}
      onOpen={open}
    />
  );
}

function ProfilesTab(s: NonNullable<ReturnType<typeof screen>>) {
  const config = configOf(s.audio);
  return (
    <ProfilesView
      config={config}
      previews={rulePreview(config, s.project.files)}
      selected={selectedProfile.value}
      scope={profileScope.value}
      readOnly={s.readOnly}
      onSelect={(n) => (selectedProfile.value = n)}
      onScope={(x) => (profileScope.value = x)}
      onAdd={() => {
        const r = addProfile(s.audio);
        if (s.commit(r, "New profile") && "next" in r) selectedProfile.value = Object.keys(configOf(r.next).profiles).at(-1)!;
      }}
      onRename={(from, to) => {
        if (!s.commit(renameProfile(s.audio, from, to), `Rename profile ${from} to ${to}`)) return;
        selectedProfile.value = to;
        void editProjectFiles(s.project, profileRenameEdit(from, to), `Rename profile ${from} to ${to}`);
      }}
      onDelete={(n) => s.commit(deleteProfile(s.audio, n), `Delete profile ${n}`)}
      onDefault={(n) => s.commit(setDefaultProfile(s.audio, n), n ? `Default profile ${n}` : "No default profile")}
      onKey={(profile, platform, key, value) => s.commit(setProfileKey(s.audio, profile, platform, key, value), `${value === undefined ? "Inherit" : "Set"} ${key} · ${profile}${platform ? ` · ${platform}` : ""}`)}
      onAddRule={(path, profile) => s.commit(addRule(s.audio, path, profile), `Add rule ${path}`)}
      onUpdateRule={(i, patch) => s.commit(updateRule(s.audio, i, patch), "Edit rule")}
      onMoveRule={(i, d) => s.commit(moveRule(s.audio, i, d), d < 0 ? "Move rule up" : "Move rule down")}
      onRemoveRule={(i) => s.commit(removeRule(s.audio, i), "Delete rule")}
    />
  );
}

/** Convert now for `platform`, keeping its report against the `audio.json` value it ran on. */
function convertNow(s: NonNullable<ReturnType<typeof screen>>, platform: ImportPlatform): void {
  if (converting.peek()) return;
  const abort = new AbortController();
  converting.value = { platform, done: 0, total: 0, abort };
  const against = s.audio;
  void convertProjectNow(s.project, platform, (p) => (converting.value = { platform, done: p.done, total: p.total, abort }), abort.signal)
    .then((report) => {
      if (report) exactReports.value = new Map([...exactReports.peek(), [platform, { report, against }]]);
      status.value = { kind: "info", text: report ? `Converted ${report.totals.files} sound${report.totals.files === 1 ? "" : "s"} for ${platform}.` : "No audio to convert." };
    })
    .catch((err: unknown) => {
      status.value = { kind: abort.signal.aborted ? "info" : "error", text: abort.signal.aborted ? "Conversion cancelled." : `Convert now failed: ${err instanceof Error ? err.message : String(err)}` };
    })
    .finally(() => (converting.value = null));
}

function ReportTab(s: NonNullable<ReturnType<typeof screen>>) {
  const platform = packagesPlatform.value;
  const c = converting.value;
  return (
    <ReportView
      report={reportFor(s, platform)}
      platform={platform}
      converting={c && c.platform === platform ? { done: c.done, total: c.total } : null}
      readOnly={c !== null}
      onPlatform={(p) => (packagesPlatform.value = p)}
      onConvert={() => convertNow(s, platform)}
      onCancel={() => converting.peek()?.abort.abort()}
      onBudget={(key, mb) => s.commit(setBudget(s.audio, platform, key, mb), `${key === "downloadMB" ? "Download" : "Memory"} budget · ${platform}`)}
    />
  );
}

const TABS: { id: PackagesTab; label: string }[] = [
  { id: "contents", label: "Contents" },
  { id: "profiles", label: "Profiles and rules" },
  { id: "report", label: "Report" },
];

function MainPanel() {
  const s = screen();
  if (!s) return noProject();
  const tab = packagesTab.value;
  const move = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    packagesTab.value = TABS[(i + step + TABS.length) % TABS.length]!.id;
  };
  return (
    <Panel bodyClass="studio-panel-body pk-main">
      <Doc>
        <div class="pk-tabs" role="tablist" aria-label="Packages views" onKeyDown={move}>
          {TABS.map((t) => (
            <button key={t.id} role="tab" id={`pk-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="pk-tabpanel" tabIndex={tab === t.id ? 0 : -1} class={tab === t.id ? "on" : undefined} onClick={() => (packagesTab.value = t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div id="pk-tabpanel" role="tabpanel" aria-labelledby={`pk-tab-${tab}`} class="pk-tabpanel">
          {tab === "contents" ? ContentsTab(s) : tab === "profiles" ? ProfilesTab(s) : ReportTab(s)}
        </div>
      </Doc>
    </Panel>
  );
}

function InspectorPanel() {
  const s = screen();
  if (!s) return noProject();
  const defs = defsOf(s.audio);
  const name = selectedPackage.value ?? defs[0]?.name ?? null;
  const def = defs.find((d) => d.name === name) ?? null;
  const platform = packagesPlatform.value;
  const report = def ? reportFor(s, platform) : null;
  return (
    <Panel class="pk-inspector-panel" bodyClass="smp-insp-body">
      <Doc>
        <PackageInspectorView
          def={def}
          platform={platform}
          figures={report?.packages.find((p) => p.name === def?.name) ?? null}
          exact={report?.exact ?? false}
          strict={strictOf(s.audio)}
          lint={lintPackageNames(s.project.scripts, defs.map((d) => d.name))}
          readOnly={s.readOnly}
          onPreload={(on) => def && s.commit(setPreload(s.audio, def.name, on), `${on ? "Preload" : "Don't preload"} ${def.name}`)}
          onShipsOn={(p, on) => def && s.commit(setShipsOn(s.audio, def.name, p, on), `${on ? "Ship" : "Don't ship"} ${def.name} on ${p}`)}
          onStrict={(on) => s.commit(setStrict(s.audio, on), on ? "Strict packages" : "Lenient packages")}
          onOpenScript={(path) => void (status.value = { kind: "info", text: `${path}: open it in the editor's Code panel to change the name.` })}
        />
      </Doc>
    </Panel>
  );
}

export const PACKAGES_PANELS: readonly StudioPanel[] = [
  { id: "packages-list", title: "Packages", dock: "left", view: () => <ListPanel /> },
  { id: "packages-main", title: "Package", dock: "fill", fixed: true, view: () => <MainPanel /> },
  { id: "packages-inspector", title: "Inspector", dock: "right", view: () => <InspectorPanel /> },
  historyPanel("packages"),
];
