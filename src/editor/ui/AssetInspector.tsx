import { useEffect, useState } from "preact/hooks";
import type { ImportSettings } from "../../engine/scene/importSettings";
import { fileName } from "../assetBrowser";
import { assetKind, kindImportSettings, kindInspector, kindLabel } from "../assetKindLookup";
import type { ImportSettingsContribution, ImportSettingsViewProps, LoadComponent } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import { inspectedAsset, readImportSettings, sameSettings, writeImportSettings } from "../assetImport";
import { errorStatus } from "../messages";
import { currentProject, docVersion, status } from "../state";
import "./assetInspector.css";

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

/** The selected asset in the Inspector (ADR 0143): its kind's own view (materials, prefabs, render textures…), else its import settings. */
export function AssetInspector() {
  const path = inspectedAsset.value;
  const inspector = path ? kindInspector(assetKind(path)) : undefined;
  if (path && inspector) {
    const View = lazyView(inspector);
    return <View path={path} />;
  }
  return <ImportInspector />;
}

/**
 * The selected file's import settings (ADR 0040, 0044), stored in its sidecar `<file>.meta.json`.
 * Edits are a draft until Apply writes the sidecar; Revert drops them, as does selecting something
 * else. The preview and the card's rows are its kind's `importSettings` (ADR 0143): images and audio
 * from the shell, models from the Meshes plugin.
 */
function ImportInspector() {
  docVersion.value; // the sidecar may be rewritten (Sprite Editor, moves)
  const path = inspectedAsset.value;
  const project = currentProject.value;
  const saved = project && path ? readImportSettings(project, path) : null;
  const savedKey = saved ? JSON.stringify(saved.settings) : "";
  const [draft, setDraft] = useState<ImportSettings | null>(saved?.settings ?? null);
  useEffect(() => setDraft(saved ? structuredClone(saved.settings) : null), [path, savedKey]);
  if (!project || !path || !saved || !draft) return <p class="empty">Nothing selected</p>;
  const kind = assetKind(path);
  const views = importViews(kindImportSettings(kind));
  const Preview = views?.preview ?? null;
  const Rows = views?.view ?? null;
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

