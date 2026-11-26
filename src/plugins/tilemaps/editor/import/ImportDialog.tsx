// The Import as Myco assets dialog (ADR 0422): for a Tiled map or tileset or an LDtk project, the output folder, pixels
// per unit, whether objects (entities) become nodes and their shapes trigger colliders, and each LDtk IntGrid value's
// collision; then every file it will write (marking the ones it overwrites) and every warning, before writing them in
// one batch. Loaded on demand with the importer (`importJob.ts`), opened by the Assets panel's action and the source
// file's Inspector.
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { KitDialog, editor, type EditorProject } from "../../../../editor/sdk";
import { defaultOutputFolder, loadImportSource, planImport, whyNotOutputFolder, writeImport } from "./importJob";
import { defaultPixelsPerUnit, intGridKey, ldtkIntGridLayers, type ImportSource, type IntGridCollision, type NativeImportOptions } from "./nativeWriter";
import "./tileImport.css";

interface ImportDialogProps {
  readonly project: EditorProject;
  readonly path: string;
  /** Closed: the files written (none when cancelled). */
  done(written: string[]): void;
}

const COLLISIONS: { value: IntGridCollision; label: string }[] = [
  { value: "none", label: "None" },
  { value: "full", label: "Solid" },
  { value: "oneWay", label: "One-way" },
];

function ImportDialog({ project, path, done }: ImportDialogProps) {
  const [source, setSource] = useState<ImportSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState(defaultOutputFolder(path));
  const [ppu, setPpu] = useState<number | null>(null);
  const [objectsAsNodes, setObjectsAsNodes] = useState(true);
  const [shapesAsTriggers, setShapesAsTriggers] = useState(false);
  const [intGrid, setIntGrid] = useState<Record<string, IntGridCollision>>({});
  const [writing, setWriting] = useState(false);
  const version = editor.project.version;

  useEffect(() => {
    let live = true;
    loadImportSource(project, path).then(
      (s) => {
        if (!live) return;
        setSource(s);
        setPpu(defaultPixelsPerUnit(s));
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [project, path]);

  const folderProblem = whyNotOutputFolder(folder);
  const options: NativeImportOptions = { folder, pixelsPerUnit: ppu ?? undefined, objectsAsNodes, shapesAsTriggers, intGridCollision: intGrid };
  const plan = useMemo(() => (source && !folderProblem ? planImport(project, source, options) : null), [source, folder, ppu, objectsAsNodes, shapesAsTriggers, intGrid, version]);
  const intGridLayers = source?.format === "ldtk" ? ldtkIntGridLayers(source) : [];
  const isTileset = source?.format === "tiledTileset";
  const overwrites = new Set(plan?.overwrites ?? []);
  const sidecars = new Set(plan?.sidecars ?? []);

  const run = async () => {
    if (!plan || writing) return;
    setWriting(true);
    const written = await writeImport(project, path, plan);
    done(written);
  };

  const what = source?.format === "ldtk" ? "LDtk project" : isTileset ? "Tiled tileset" : "Tiled map";
  const summary = error ? "Nothing to import." : !plan ? (folderProblem ?? "Reading…") : `${plan.files.length} file${plan.files.length === 1 ? "" : "s"}${plan.warnings.length ? ` · ${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"}` : ""}`;

  return (
    <KitDialog
      title={`Import ${editor.assets.fileName(path)} as Myco assets`}
      width={620}
      class="tile-import"
      summary={summary}
      onClose={() => done([])}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
          e.preventDefault();
          void run();
        }
      }}
      buttons={
        <>
          <button onClick={() => done([])}>Cancel</button>
          <button class={overwrites.size ? "danger" : "primary"} disabled={!plan || writing || !project.canSave} onClick={() => void run()}>
            {overwrites.size ? "Overwrite and import" : "Import"}
          </button>
        </>
      }
    >
      {error ? (
        <p class="tile-import-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <p class="tile-import-lead">
            Converts this {what} into Myco tilesets{isTileset ? "" : " and prefabs"} once. Re-importing later overwrites them, keeping tile uuids and node ids so scenes still work.
          </p>
          <div class="tile-import-form">
            <label>
              <span>Output folder</span>
              <input type="text" value={folder} placeholder="(project root)" spellcheck={false} onInput={(e) => setFolder((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <label>
              <span>Pixels per unit</span>
              <input
                type="number"
                min={1}
                step={1}
                value={ppu ?? ""}
                onInput={(e) => {
                  const n = Number((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(n) && n > 0) setPpu(n);
                }}
              />
            </label>
            {!isTileset && (
              <>
                <label class="tile-import-check">
                  <input type="checkbox" checked={objectsAsNodes} onChange={(e) => setObjectsAsNodes((e.currentTarget as HTMLInputElement).checked)} />
                  <span>{source?.format === "ldtk" ? "Entities" : "Objects"} become nodes</span>
                </label>
                <label class="tile-import-check">
                  <input type="checkbox" checked={shapesAsTriggers} disabled={!objectsAsNodes} onChange={(e) => setShapesAsTriggers((e.currentTarget as HTMLInputElement).checked)} />
                  <span>Their shapes become trigger colliders</span>
                </label>
              </>
            )}
          </div>
          {intGridLayers.length > 0 && (
            <fieldset class="tile-import-intgrid">
              <legend>IntGrid collision</legend>
              {intGridLayers.flatMap(({ layer, values }) =>
                values.map((v) => {
                  const key = intGridKey(layer, v.value);
                  return (
                    <label key={key}>
                      <span class="tile-import-swatch" style={{ background: v.color }} aria-hidden="true" />
                      <span class="tile-import-value">
                        {layer} · {v.value}
                        {v.identifier ? ` ${v.identifier}` : ""}
                      </span>
                      <select value={intGrid[key] ?? "none"} onChange={(e) => setIntGrid({ ...intGrid, [key]: (e.currentTarget as HTMLSelectElement).value as IntGridCollision })}>
                        {COLLISIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }),
              )}
            </fieldset>
          )}
          {folderProblem && <p class="tile-import-error">{folderProblem}</p>}
          {plan && (
            <>
              <h3 class="tile-import-heading">Files</h3>
              <ul class="tile-import-files">
                {plan.files.map((f) => (
                  <li key={f.path}>
                    <span class="tile-import-path">{f.path}</span>
                    {overwrites.has(f.path) && <span class="tile-import-tag tile-import-overwrite">overwrites</span>}
                    {sidecars.has(f.path) && <span class="tile-import-tag">adds slices</span>}
                  </li>
                ))}
              </ul>
              {plan.warnings.length > 0 && (
                <>
                  <h3 class="tile-import-heading">Warnings</h3>
                  <ul class="tile-import-warnings">
                    {plan.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </KitDialog>
  );
}

/**
 * Open the import dialog for the source file at `path` in the open project. Resolves when it closes, to the files it
 * wrote (none when cancelled or with no project open).
 */
export function openImportDialog(path: string): Promise<string[]> {
  const project = editor.project.peek();
  if (!project) return Promise.resolve([]);
  if (editor.project.refuseReadOnly(project, "imports")) return Promise.resolve([]);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const done = (written: string[]) => {
      render(null, host);
      host.remove();
      resolve(written);
    };
    render(<ImportDialog project={project} path={path} done={done} />, host);
  });
}
