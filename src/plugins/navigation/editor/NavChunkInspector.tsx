// Under a NavChunk's fields in the Inspector (ADR 0065): the Bake button, the bake's progress by stage,
// the last bake's summary (polys, fingerprints, warnings, time), and a notice when the chunk's inputs
// changed since (its geometry, volumes, NavChunk fields or the project's navigation settings).
import { useEffect } from "preact/hooks";
import { navPolyCount, NAV_STAGE_LABELS, bakeOpenSceneChunk, checkNavInputs, isNavBakeStale, lookUpNavRecord, navBakeSummary, navBakeVersion, navChunkState } from "./navBake";
import { currentProject, docVersion, type OpenScene } from "../../../editor/state";
import "../../../editor/ui/bake.css";
import "./navBake.css";
import type { InspectorSectionProps } from "../../../editor/ui/inspectorSections";

export function NavChunkBake(props: { scene: OpenScene; nodeId: string }) {
  const { scene, nodeId } = props;
  navBakeVersion.value;
  const version = docVersion.value;
  const project = currentProject.value;
  const node = scene.sync.nodeFor([nodeId]);
  const chunkId = node ? node.id || node.name : nodeId;
  const s = navChunkState(scene.path, chunkId);
  const settingsKey = JSON.stringify((project?.settings as { navigation?: unknown } | undefined)?.navigation ?? null);

  // The last bake's record, once; then the inputs' signature, a moment after each edit.
  useEffect(() => {
    if (project && node) void lookUpNavRecord(project, scene.path, node);
  }, [project, scene, nodeId]);
  useEffect(() => {
    if (!project || !node) return;
    const timer = setTimeout(() => {
      if (node.isValid) void checkNavInputs(project, scene.path, scene.sync.world, node).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [project, scene, nodeId, version, settingsKey, s.record?.inputSignature]);

  if (!project || !node) return null;
  const record = s.record ?? null;
  const stale = isNavBakeStale(s);
  return (
    <div class="nav-chunk-bake" aria-label="Navigation bake">
      <div class="nav-chunk-bake-row">
        <button disabled={!project.canSave || s.stage !== null} title={project.canSave ? `Bake ${node.name}'s navigation` : "Read-only project: open a project folder to bake"} onClick={() => void bakeOpenSceneChunk(scene, nodeId, project)}>
          {s.stage ? "Baking…" : record ? "Rebake" : "Bake"}
        </button>
        <span class="nav-chunk-bake-status" aria-live="polite">
          {s.stage ? NAV_STAGE_LABELS[s.stage] : !project.canSave ? "Read-only: open a project folder to bake." : record ? (stale ? "" : "Up to date") : "Not baked yet"}
        </span>
      </div>
      {stale && !s.stage && <p class="nav-chunk-stale" role="status">The scene or navigation settings changed since this bake. Rebake to update it.</p>}
      {s.error && <p class="nav-chunk-error" role="alert">{s.error}</p>}
      {record && (
        <div class="nav-chunk-summary" aria-label="Last bake">
          <p class="nav-chunk-summary-line">
            {record.asset}: {navBakeSummary(record)}
          </p>
          <dl>
            <dt>Polys</dt>
            <dd>{navPolyCount(record.report).toLocaleString("en")}</dd>
            <dt>Tiles</dt>
            <dd>
              {record.report.report.tiles} ({record.report.report.reusedTiles} reused)
            </dd>
            <dt>Triangles in</dt>
            <dd>{record.report.report.triangles.toLocaleString("en")}</dd>
            <dt>Baked</dt>
            <dd>{new Date(record.bakedAt).toLocaleString()}</dd>
            <dt>Fingerprints</dt>
            <dd class="nav-chunk-fingerprints" title={record.report.fingerprints.join("\n")}>
              {record.report.fingerprints.length ? record.report.fingerprints.map((f) => f.slice(0, 8)).join(" ") : "none"}
            </dd>
          </dl>
          {record.report.warnings.length > 0 && (
            <ul class="nav-chunk-warnings" aria-label="Bake warnings">
              {record.report.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The Inspector section under a top-level NavChunk (ADR 0065, 0131). */
export function NavChunkBakeSection({ scene, paths }: InspectorSectionProps) {
  return <NavChunkBake scene={scene} nodeId={paths[0][0]} />;
}
