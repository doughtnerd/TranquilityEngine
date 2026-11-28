import { useMemo, useState } from "preact/hooks";
import type { ImportSettings } from "../../engine/scene/importSettings";
import { fileName } from "../projectPath";
import { assetKind, kindImportSections, kindImportSettings, kindInspector, kindLabel } from "../assetKindLookup";
import type { ImportSettingsContribution, ImportSettingsSectionContribution, ImportSettingsViewProps, LoadComponent } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import { readImportSettings, sameSettings, writeImportSettings } from "../assetImport";
import { errorStatus } from "../messages";
import { currentProject, docVersion, status } from "../state";
import "./assetInspector.css";
import { EmptyState } from "./EmptyState";

/** One lazy view per loader (ADR 0083): created on first use, so its module loads then. */
const lazyViews = new WeakMap<LoadComponent<never>, LazyComponent<never>>();
function lazyView<P extends object>(load: LoadComponent<P>): LazyComponent<P> {
  let view = lazyViews.get(load as LoadComponent<never>) as LazyComponent<P> | undefined;
  if (!view) lazyViews.set(load as LoadComponent<never>, (view = lazyComponent(load, null)) as LazyComponent<never>);
  return view;
}

/** A kind's import settings views, loaded lazily. */
function importViews(views: ImportSettingsContribution | undefined): { preview: LazyComponent<{ path: string }> | null; view: LazyComponent<ImportSettingsViewProps> } | null {
  if (!views) return null;
  return { preview: views.preview ? lazyView(views.preview) : null, view: lazyView(views.view) };
}

/** An asset in the Inspector (ADR 0143, 0242): its kind's own view (materials, prefabs, render textures…), else its import settings. */
export function AssetInspector(props: { path: string }) {
  const { path } = props;
  const inspector = kindInspector(assetKind(path));
  if (inspector) {
    const View = lazyView(inspector);
    return <View path={path} />;
  }
  return <ImportInspector path={path} />;
}

/** A card another plugin added to the kind's Import Settings (ADR 0373): its rows edit the same draft, so Apply and Revert cover them. */
function ImportSection(props: { section: ImportSettingsSectionContribution; viewProps: ImportSettingsViewProps }) {
  const View = lazyView(props.section.view);
  return (
    <div class="component asset-import-card" data-import-section={props.section.id}>
      <h3>{props.section.title}</h3>
      <View {...props.viewProps} />
    </div>
  );
}

/**
 * The selected file's import settings (ADR 0040, 0044), stored in its sidecar `<file>.meta.json`.
 * Edits are a draft until Apply writes the sidecar; Revert drops them, as does selecting something
 * else. The preview and the card's rows are its kind's `importSettings` (ADR 0143): images and audio
 * from the shell, models from the Meshes plugin.
 */
function ImportInspector(props: { path: string }) {
  docVersion.value; // the sidecar may be rewritten (Sprite Editor, moves)
  const { path } = props;
  const project = currentProject.value;
  const saved = project && path ? readImportSettings(project, path) : null;
  const savedKey = saved ? JSON.stringify(saved.settings) : "";
  // The draft belongs to the file and the settings it was made from: another file (or the sidecar rewritten) starts
  // from its saved settings in the same render, never showing the previous file's draft first.
  const source = `${path}\n${savedKey}`;
  const fresh = useMemo(() => (saved ? structuredClone(saved.settings) : null), [source]);
  const [edited, setEdited] = useState<{ source: string; settings: ImportSettings } | null>(null);
  const draft = edited && edited.source === source ? edited.settings : fresh;
  const setDraft = (settings: ImportSettings) => setEdited({ source, settings });
  if (!project || !path || !saved || !draft) return <EmptyState compact title="Nothing selected" />;
  const kind = assetKind(path);
  const views = importViews(kindImportSettings(kind));
  const Preview = views?.preview ?? null;
  const Rows = views?.view ?? null;
  const sections = kindImportSections(kind);
  const dirty = !sameSettings(draft, saved.settings);
  const set = (patch: Partial<ImportSettings>) => setDraft({ ...draft, ...patch });
  const readOnly = project.canSave ? null : "This project is read-only.";

  const apply = async () => {
    try {
      await writeImportSettings(project, path, draft);
      docVersion.value++;
      status.value = { kind: "info", text: `Saved import settings for ${fileName(path)}.` };
    } catch (err) {
      status.value = errorStatus(`Couldn't save import settings for ${fileName(path)}`, err);
    }
  };

  return (
    <div class="inspector-body asset-inspector" aria-label="Import settings">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">{kindLabel(kind)}</span>
        <span class="asset-inspector-name" title={path}>
          {fileName(path)}
        </span>
      </div>
      {Preview && <Preview path={path} />}
      {saved.problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {saved.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="component asset-import-card">
        <h3>Import Settings</h3>
        {Rows && <Rows path={path} project={project} draft={draft} set={set} replace={setDraft} dirty={dirty} readOnly={readOnly} />}
      </div>
      {sections.map((s) => (
        <ImportSection key={s.id} section={s} viewProps={{ path, project, draft, set, replace: setDraft, dirty, readOnly }} />
      ))}
      <div class="asset-inspector-actions">
        <button disabled={!dirty} onClick={() => setDraft(structuredClone(saved.settings))}>
          Revert
        </button>
        <button class="primary" disabled={!dirty || !!readOnly} title={readOnly ?? (dirty ? `Write ${fileName(path)}.meta.json` : "Nothing to apply")} onClick={() => void apply()}>
          Apply
        </button>
      </div>
      <p class="asset-inspector-note">
        Saved beside the file as <code>{fileName(path)}.meta.json</code>.
      </p>
    </div>
  );
}

