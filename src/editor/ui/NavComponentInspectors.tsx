// Under navigation components' fields in the Inspector (ADR 0065), ports of Foxfire's custom editors:
// - NavAgent (NavAgentAuthoringEditor): a warning when no NavChunk in the open scene bakes its agent type.
// - NavChunk (NavChunkAuthoringEditor): what the chunk bakes for each agent type (its navmesh and flight volume, and
//   which types share them, by the bake's own grouping), skipped types, Walkable For warnings, and the Surface bins
//   preview toggle with the bin layout's summary (SurfaceBinsPreview).
// - NavResolutionVolume (NavResolutionVolumeEditor): the cell size the region gets in each flying agent type's
//   flight volume, and a warning where it does nothing.
// - NavModifierVolume: what its flight preview found (ModifierVolumeFlightPreview).
import { useEffect, useState } from "preact/hooks";
import { NavChunk } from "../../engine/nav/components";
import { collectNavGeometry, loadNavGeometryMeshes } from "../../engine/nav/geometry";
import { chunkBakesAgentType, describeNavBakePlan, describeSurfaceBins, navBakePlan, resolutionRegionEffects, resolveAgentType, surfaceBinLayout, type NavBakePlan } from "../../engine/nav/plan";
import type { NavigationSettings } from "../../engine/nav/settings";
import { projectNavigation } from "../navBake";
import { navAvoidanceSummary, navObstacleSummary } from "../navSettingsModel";
import { navPreviewStatus, navSurfaceBins } from "../navPreviews";
import { currentProject, docVersion, type OpenScene } from "../state";
import "./navBake.css";
import "./navInspectors.css";

/** The open scene's NavChunk components, in node order. */
function sceneChunks(scene: OpenScene): NavChunk[] {
  return [...scene.sync.world._componentsOfType(NavChunk)].filter((c) => !c._destroyed);
}

const typeName = (settings: NavigationSettings, id: string) => settings.agentTypes.find((t) => t.id === id)?.name || id;

/** NavAgent: whether any NavChunk in the scene bakes the agent's type. */
export function NavAgentBakeNote(props: { scene: OpenScene; agentType: string }) {
  docVersion.value;
  const settings = projectNavigation(currentProject.value);
  const type = resolveAgentType(settings, props.agentType);
  if (!type) {
    return (
      <p class="nav-note nav-note-warning" role="status">
        {settings.agentTypes.length === 0 ? "The project has no navigation agent types (Project Settings > Navigation): this node won't be an agent." : `Unknown agent type "${props.agentType}": this node won't be an agent.`}
      </p>
    );
  }
  const chunks = sceneChunks(props.scene);
  if (chunks.length === 0) return <p class="nav-note">There's no NavChunk in this scene: nothing is baked for this agent here.</p>;
  if (chunks.some((c) => chunkBakesAgentType(settings, c.skipAgents, type.id))) return null;
  return (
    <p class="nav-note nav-note-warning" role="status">
      {type.name || type.id} isn't baked by {chunks[0].node.name}: the chunk's Skip Agents skips it. No navmesh or flight volume is baked for it, so this agent won't move.
    </p>
  );
}

/** Foxfire's avoidance summary under a NavAgent (its type's "On / Avoids / Avoided by") or a NavAvoidanceObstacle. */
export function NavAvoidanceNote(props: { agentType?: string; obstacleLayers?: number }) {
  const settings = projectNavigation(currentProject.value);
  let lines: string[];
  if (props.obstacleLayers !== undefined) lines = navObstacleSummary(settings, props.obstacleLayers);
  else {
    const type = resolveAgentType(settings, props.agentType ?? "");
    lines = type ? navAvoidanceSummary(settings, type) : [];
  }
  if (lines.length === 0) return null;
  return (
    <p class="nav-note" aria-label="Avoidance summary">
      {lines.map((l, i) => (
        <span key={i} class="nav-note-line">
          {l}
        </span>
      ))}
    </p>
  );
}

/** NavChunk: what it bakes for each agent type and what it shares, above the Bake button; the Surface bins toggle. */
export function NavChunkPlanSummary(props: { scene: OpenScene; nodeId: string }) {
  const { scene, nodeId } = props;
  const version = docVersion.value;
  const project = currentProject.value;
  const settings = projectNavigation(project);
  const settingsKey = JSON.stringify(settings);
  const [plan, setPlan] = useState<{ plan: NavBakePlan; walkWarnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const node = scene.sync.nodeFor([nodeId]);

  useEffect(() => {
    if (!node) return;
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await loadNavGeometryMeshes(scene.sync.world, node, settings);
          if (!live || !node.isValid) return;
          const geometry = collectNavGeometry(scene.sync.world, node, settings);
          const p = await navBakePlan(settings, geometry);
          // Walking types that meshes' Walkable For lists leave out (DrawWalkableForWarnings).
          const lists = geometry.meshes.filter((m) => (m.kind ?? "navMesh") === "navMesh").map((m) => m.walkableFor ?? []);
          const walkWarnings: string[] = [];
          for (const t of p.agentTypes) {
            if (!t.baked || !t.walks || lists.length === 0) continue;
            const excluded = lists.filter((l) => l.length > 0 && !l.includes(t.id)).length;
            if (excluded === 0) continue;
            walkWarnings.push(
              excluded === lists.length
                ? `${t.name || t.id} can't walk anywhere: all ${lists.length} walkable meshes list other agent types under Walkable For. Add it to those lists (or clear them).`
                : `${t.name || t.id}: ${excluded} of ${lists.length} walkable meshes aren't walkable for it (their Walkable For lists leave it out).`,
            );
          }
          if (live) {
            setPlan({ plan: p, walkWarnings });
            setError(null);
          }
        } catch (err) {
          if (live) setError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scene, nodeId, version, settingsKey]);

  if (!node) return null;
  const chunk = node.getComponent(NavChunk);
  const unknownSkips = (chunk?.skipAgents ?? []).filter((id) => !settings.agentTypes.some((t) => t.id === id));
  return (
    <div class="nav-chunk-plan" aria-label="What this chunk bakes">
      <p class="nav-note">
        This chunk bakes its own navigation from {chunk?.scope === "children" ? "its children" : "the whole scene"}. Agent types, areas, surfaces and voxel settings come from Project Settings &gt; Navigation, shared by every chunk.
      </p>
      {settings.agentTypes.length === 0 && <p class="nav-note nav-note-warning">The project has no navigation agent types: nothing is baked.</p>}
      {error && <p class="nav-note nav-note-warning">{error}</p>}
      {plan && plan.plan.agentTypes.length > 0 && (
        <ul class="nav-plan-list" aria-label="Bake plan">
          {describeNavBakePlan(plan.plan).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {unknownSkips.map((id) => (
        <p key={id} class="nav-note">
          Skip Agents lists {id}, which the project doesn't bake anyway.
        </p>
      ))}
      {plan?.walkWarnings.map((w) => (
        <p key={w} class="nav-note nav-note-warning">
          {w}
        </p>
      ))}
      {plan?.plan.warnings.map((w) => (
        <p key={w} class="nav-note nav-note-warning">
          {w}
        </p>
      ))}
      <SurfaceBinsSection settings={settings} nodeKey={nodeId} />
    </div>
  );
}

/** The Surface bins toggle and the bin layout's summary. */
function SurfaceBinsSection(props: { settings: NavigationSettings; nodeKey: string }) {
  const on = navSurfaceBins.value;
  const key = JSON.stringify([props.settings.orientation, props.settings.surfaceRings]);
  const [text, setText] = useState<{ summary: string[]; warnings: string[]; error?: string } | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void surfaceBinLayout(props.settings).then((layout) => {
      if (!live) return;
      setText("error" in layout ? { summary: [], warnings: [], error: layout.error } : describeSurfaceBins(layout));
    });
    return () => {
      live = false;
    };
  }, [on, key]);
  const status = navPreviewStatus.value;
  return (
    <div class="nav-bins">
      <label class="nav-bins-toggle" title="Outline the chunk's walkable triangles in the scene view by the orientation bin each one bakes into (grey: walkable in no bin), with each bin's normal and coverage cone at the chunk node.">
        <input type="checkbox" aria-label="Surface bins" checked={on} onChange={(e) => (navSurfaceBins.value = (e.currentTarget as HTMLInputElement).checked)} />
        Surface bins
      </label>
      {on && text?.error && <p class="nav-note nav-note-warning">{text.error}</p>}
      {on && text && !text.error && (
        <div class="nav-note">
          {text.summary.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      {on && text?.warnings.map((w) => (
        <p key={w} class="nav-note nav-note-warning">
          {w}
        </p>
      ))}
      {on && status?.kind === "bins" && status.node === props.nodeKey && <p class="nav-note">{status.text}</p>}
    </div>
  );
}

/** NavResolutionVolume: the cell size it gives each flying agent type, and where it does nothing. */
export function NavResolutionSummary(props: { scene: OpenScene; nodeKey: string; cellSize: number; agents: string[] }) {
  docVersion.value;
  const settings = projectNavigation(currentProject.value);
  const chunks = sceneChunks(props.scene);
  const status = navPreviewStatus.value;
  const preview = status?.kind === "resolution" && status.node === props.nodeKey ? <p class="nav-note">{status.text}</p> : null;
  if (chunks.length === 0) return <p class="nav-note">There's no NavChunk in this scene: nothing is baked here.</p>;
  const chunk = chunks[0];
  const notFlying = props.agents.filter((id) => {
    const t = settings.agentTypes.find((a) => a.id === id);
    return t && !t.canFly;
  });
  const effects = resolutionRegionEffects(settings, chunk.skipAgents, props.cellSize, props.agents);
  const fmt = (v: number) => +v.toFixed(3);
  return (
    <div class="nav-resolution" aria-label="Resolution region">
      {notFlying.map((id) => (
        <p key={id} class="nav-note nav-note-warning">
          {typeName(settings, id)} can't fly: resolution regions only refine flight volumes.
        </p>
      ))}
      {effects.length === 0 ? (
        <p class="nav-note nav-note-warning" role="status">
          No flying agent type baked by {chunk.node.name} that this region applies to: it does nothing.
        </p>
      ) : (
        <div class={effects.some((e) => e.level === 0) ? "nav-note nav-note-warning" : "nav-note"} role="status">
          {effects.map((e) => (
            <div key={e.id}>
              {e.level === 0
                ? `${e.name}: no effect (its flight cells are about ${fmt(e.baseCell)}; Cell Size must be at most half that)`
                : `${e.name}: cells of about ${fmt(e.cell)} here, ${1 << e.level}x finer than its ${fmt(e.baseCell)}`}
            </div>
          ))}
          <div class="nav-note-aside">Sizes are rounded to whole voxels when baked; the bake's warnings report regions that end up doing nothing.</div>
        </div>
      )}
      {preview}
    </div>
  );
}

/** NavModifierVolume: what the flight preview found (when it applies to the air). */
export function NavModifierPreviewNote(props: { nodeKey: string; appliesTo: string; area: string }) {
  const status = navPreviewStatus.value;
  if (props.appliesTo === "ground") return null;
  if (!props.area) return <p class="nav-note">Set an area to see the flight cells it marks.</p>;
  return status?.kind === "modifier" && status.node === props.nodeKey ? <p class="nav-note">{status.text}</p> : null;
}
