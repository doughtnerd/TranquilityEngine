// The Project panel's Navigation section (ADR 0065): agent types as cards (walking with a voxel preview,
// flying, avoidance, area cost overrides), areas, the advanced voxel / tile / build / flight / chunk grid
// settings in a collapsible block, and Bake All. Edits go through the panel's undo history and save like
// its other sections; values the parser rejects are listed as problems and keep the file unchanged.
import type { ComponentChildren } from "preact";
import { MAX_NAV_AGENT_TYPES, MAX_NAV_AREAS, NAV_EASES, isNavAvoidanceLayerNamed, navAvoidanceLayerName, navShownLayers, type NavAgentType, type NavigationSettings } from "../../engine/nav/settings";
import { bakeAllFromPanel, navBakeAllProgress } from "../navBake";
import {
  addNavAgentType,
  addNavArea,
  addNavAvoidanceLayer,
  navAgentLayer,
  navAgentTypeWarnings,
  navAvoidanceLayerUsers,
  navAvoidanceMatrix,
  navAvoidanceSummary,
  navListedLayers,
  nextFreeNavAvoidanceLayer,
  renameNavAvoidanceLayer,
  setNavAgentLayer,
  setNavAvoidanceCell,
  navAreaCostOf,
  navColorHex,
  navHexColor,
  navigationOf,
  navVoxelSize,
  removeNavAgentType,
  removeNavArea,
  renameNavAgentType,
  resetNavigation,
  setNavAgentAreaCost,
  setNavAgentAvoidance,
  setNavAgentValue,
  setNavAreaValue,
  setNavValue,
} from "../navSettingsModel";
import type { SettingsDraft } from "../projectSettingsModel";
import type { EditorProject } from "../projects";
import { TextField } from "./WorldsPanel";
import "./navSettings.css";

type Set = (label: string, next: SettingsDraft) => void;

/** A number input that commits on change (Enter, blur or the arrows), as the tier cards' inputs do. */
function Num(props: { label: string; value: number; step?: number; min?: number; max?: number; disabled?: boolean; onCommit: (n: number) => void }) {
  return (
    <input
      type="number"
      aria-label={props.label}
      value={props.value}
      step={props.step ?? "any"}
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      onChange={(e) => {
        const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
        if (Number.isFinite(n) && n !== props.value) props.onCommit(n);
      }}
    />
  );
}

function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <input type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />;
}

function Choice<T extends string>(props: { label: string; value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (v: T) => void }) {
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((o) => (
        <option key={o} value={o}>
          {props.labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

/** One labelled cell of a card's grid. */
function Cell(props: { label: string; class?: string; children: ComponentChildren }) {
  return (
    <label class={props.class}>
      <span class="tier-label">{props.label}</span>
      {props.children}
    </label>
  );
}

const WALK_NUMBERS: [key: string, label: string, step?: number][] = [
  ["radius", "Radius", 0.05],
  ["height", "Height", 0.1],
  ["stepHeight", "Step height", 0.05],
  ["speed", "Speed", 0.5],
  ["turnSpeed", "Turn speed", 1],
  ["maxFoldAngleDeg", "Max fold angle°", 5],
  ["arrivalDistance", "Arrival distance", 0.1],
  ["waypointReachedDistance", "Waypoint distance", 0.1],
  ["maxSnapDistance", "Max snap distance", 0.5],
  ["repathInterval", "Repath interval (s)", 0.5],
  ["offPathDistance", "Off-path distance", 0.5],
  ["stuckSkipTime", "Stuck skip time (s)", 0.5],
];
const JUMP_NUMBERS: [string, string, number][] = [
  ["maxJumpUpHeight", "Max jump up", 0.1],
  ["maxJumpDistance", "Max jump distance", 0.1],
  ["maxFallDistance", "Max fall", 0.1],
  ["jumpArcHeight", "Jump arc height", 0.1],
  ["jumpCost", "Jump cost", 0.05],
];
const FLIGHT_NUMBERS: [string, string, number][] = [
  ["radius", "Radius", 0.05],
  ["speed", "Speed", 0.5],
  ["turnSpeed", "Turn speed", 1],
  ["takeoffHeight", "Takeoff height", 0.5],
  ["takeoffSpeed", "Takeoff speed", 0.5],
  ["maxFlightDistance", "Max flight (0 = ∞)", 1],
  ["flightCostMultiplier", "Flight cost ×", 0.1],
  ["takeoffCost", "Takeoff cost", 0.5],
  ["landingCost", "Landing cost", 0.5],
  ["maxLandingSlopeDeg", "Max landing slope°", 5],
  ["arrivalDistance", "Arrival distance", 0.1],
  ["walkInsteadRatio", "Walk instead ratio", 0.1],
];
const AVOIDANCE_NUMBERS: [string, string, number][] = [
  ["radius", "Radius (0 = agent's)", 0.05],
  ["neighborDistance", "Neighbour distance", 0.5],
  ["maxNeighbors", "Max neighbours", 1],
  ["timeHorizon", "Time horizon (s)", 0.1],
  ["obstacleTimeHorizon", "Obstacle horizon (s)", 0.1],
  ["priority", "Priority (0 first)", 1],
];

/** Foxfire's NavAvoidanceLayerDrawer: "Nothing" and the named layers, plus the one in use. */
function LayerChoice(props: { nav: NavigationSettings; t: NavAgentType; i: number; draft: SettingsDraft; set: Set }) {
  const { nav, t, i, draft, set } = props;
  const on = navAgentLayer(t);
  const shown = navShownLayers(nav, t.avoidance?.layers ?? 0);
  return (
    <select
      aria-label={`${t.name} avoidance layer`}
      value={on === null ? "" : String(on)}
      onChange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        const layer = v === "" ? null : Number(v);
        set(`Put ${t.name} on ${layer === null ? "no avoidance layer" : navAvoidanceLayerName(nav, layer)}`, setNavAgentLayer(draft, i, layer));
      }}
    >
      <option value="">Nothing</option>
      {shown.map((l) => (
        <option key={l} value={String(l)}>
          {navAvoidanceLayerName(nav, l)}
        </option>
      ))}
    </select>
  );
}

function AgentCard(props: { nav: NavigationSettings; t: NavAgentType; i: number; draft: SettingsDraft; set: Set; count: number }) {
  const { nav, t, i, draft, set } = props;
  const value = (path: string, label: string) => (v: unknown) => set(`Set ${t.name} ${label}`, setNavAgentValue(draft, i, path, v));
  const walk = t.walk as unknown as Record<string, number | boolean>;
  const flight = t.flight as unknown as Record<string, number | boolean>;
  const voxels = navVoxelSize(nav, t);
  const warnings = navAgentTypeWarnings(nav, t);
  const summary = navAvoidanceSummary(nav, t);
  return (
    <div class="tier-card nav-agent-card" data-agent={t.id} role="group" aria-label={`Agent type ${t.name}`}>
      <div class="tier-card-head">
        <TextField value={t.name} label={`Agent type ${i + 1} name`} onCommit={(v) => set(`Rename agent type to ${v.trim()}`, renameNavAgentType(draft, i, v.trim()))} />
        <span class="tier-buttons">
          <button class="icon" aria-label={`Remove ${t.name}`} title={props.count <= 1 ? "Agents need at least one agent type" : "Remove this agent type"} disabled={props.count <= 1} onClick={() => set(`Remove agent type ${t.name}`, removeNavAgentType(draft, i))}>
            ×
          </button>
        </span>
      </div>
      <p class="project-settings-hint nav-id" title="Agents and bakes refer to the type by this id">
        id {t.id}
      </p>
      {warnings.length > 0 && (
        <ul class="nav-warnings" role="alert" aria-label={`${t.name} warnings`}>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div class="nav-card-toggle">
        <Check label={`${t.name} walks`} checked={t.canWalk} onChange={(on) => value("canWalk", "walking")(on)} />
        <span>Walks</span>
      </div>
      {t.canWalk && (
        <>
          <div class="tier-fields">
            {WALK_NUMBERS.map(([key, label, step]) => (
              <Cell key={key} label={label}>
                <Num label={`${t.name} ${label.toLowerCase()}`} value={walk[key] as number} step={step} onCommit={value(`walk.${key}`, label.toLowerCase())} />
              </Cell>
            ))}
            <Cell label="Ease">
              <Choice label={`${t.name} ease`} value={t.walk.motion.ease} options={NAV_EASES} onChange={value("walk.motion.ease", "ease")} />
            </Cell>
            <Cell label="Climbs walls">
              <Check label={`${t.name} climbs walls`} checked={t.walk.canClimbWalls} onChange={value("walk.canClimbWalls", "wall climbing")} />
            </Cell>
            <Cell label="Walks ceilings">
              <Check label={`${t.name} walks ceilings`} checked={t.walk.canWalkCeilings} onChange={value("walk.canWalkCeilings", "ceiling walking")} />
            </Cell>
            <Cell label="Jumps">
              <Check label={`${t.name} jumps`} checked={t.walk.canJump} onChange={value("walk.canJump", "jumping")} />
            </Cell>
            {t.walk.canJump &&
              JUMP_NUMBERS.map(([key, label, step]) => (
                <Cell key={key} label={label}>
                  <Num label={`${t.name} ${label.toLowerCase()}`} value={walk[key] as number} step={step} onCommit={value(`walk.${key}`, label.toLowerCase())} />
                </Cell>
              ))}
          </div>
          <p class="nav-voxel-preview" aria-label={`${t.name} voxels`} title={nav.voxels === "fixed" ? "Fixed voxels (Advanced)" : `Auto voxels: radius ÷ ${nav.cellsPerRadius} cells per radius, half the step height tall`}>
            Voxels {voxels.cellSize} × {voxels.cellHeight} m: radius ≈ {voxels.radiusCells} cells, step {voxels.stepCells} cells, height {voxels.heightCells} cells
            {voxels.stepCells < 2 && t.walk.stepHeight > 0 ? " (steps under 2 cells may not climb)" : ""}
          </p>
        </>
      )}

      <div class="nav-card-toggle">
        <Check label={`${t.name} flies`} checked={t.canFly} onChange={value("canFly", "flying")} />
        <span>Flies</span>
      </div>
      {t.canFly && (
        <div class="tier-fields">
          {FLIGHT_NUMBERS.map(([key, label, step]) => (
            <Cell key={key} label={label}>
              <Num label={`${t.name} flight ${label.toLowerCase()}`} value={flight[key] as number} step={step} onCommit={value(`flight.${key}`, `flight ${label.toLowerCase()}`)} />
            </Cell>
          ))}
          <Cell label="Lands when out of reach">
            <Check label={`${t.name} lands when out of reach`} checked={t.flight.landWhenOutOfReach} onChange={value("flight.landWhenOutOfReach", "landing when out of reach")} />
          </Cell>
        </div>
      )}

      <div class="nav-card-toggle">
        <Check label={`${t.name} avoids others`} checked={t.avoidance !== null} onChange={(on) => set(`${on ? "Turn on" : "Turn off"} ${t.name} avoidance`, setNavAgentAvoidance(draft, i, on))} />
        <span>Avoids others</span>
      </div>
      {t.avoidance && (
        <div class="tier-fields">
          <Cell label="On layer">
            <LayerChoice nav={nav} t={t} i={i} draft={draft} set={set} />
          </Cell>
          {AVOIDANCE_NUMBERS.map(([key, label, step]) => (
            <Cell key={key} label={label}>
              <Num label={`${t.name} avoidance ${label.toLowerCase()}`} value={(t.avoidance as unknown as Record<string, number>)[key]} step={step} onCommit={value(`avoidance.${key}`, `avoidance ${label.toLowerCase()}`)} />
            </Cell>
          ))}
        </div>
      )}
      {summary.length > 0 && (
        <p class="nav-avoidance-summary" aria-label={`${t.name} avoidance summary`}>
          {summary.join("\n")}
        </p>
      )}
      <div class="nav-card-toggle">
        <Check label={`${t.name} joins groups`} checked={t.joinGroups} onChange={value("joinGroups", "group joining")} />
        <span>Joins groups going the same way</span>
      </div>

      {nav.areas.length > 0 && (
        <div class="nav-area-costs" role="group" aria-label={`${t.name} area costs`}>
          <span class="tier-label">Area costs</span>
          {nav.areas.map((a) => {
            const cost = navAreaCostOf(t, a.id);
            return (
              <div key={a.id} class="project-settings-item">
                <span class="project-settings-path">{a.name}</span>
                <input
                  type="number"
                  step="any"
                  aria-label={`${t.name} cost of ${a.name}`}
                  placeholder={String(a.cost)}
                  value={typeof cost === "number" ? cost : ""}
                  disabled={cost === "excluded"}
                  onChange={(e) => {
                    const raw = (e.currentTarget as HTMLInputElement).value.trim();
                    const n = Number(raw);
                    set(`Set ${t.name} cost of ${a.name}`, setNavAgentAreaCost(draft, i, a.id, raw === "" ? null : Number.isFinite(n) ? n : null));
                  }}
                />
                <label class="nav-inline">
                  <Check label={`${t.name} never walks ${a.name}`} checked={cost === "excluded"} onChange={(on) => set(`${on ? "Exclude" : "Allow"} ${a.name} for ${t.name}`, setNavAgentAreaCost(draft, i, a.id, on ? "excluded" : null))} />
                  excluded
                </label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Foxfire's Avoidance Layers page: the layer names (named ones, layer 0 and any in use; "+ Avoidance layer" names the
 * next free slot) and the who-avoids-whom matrix.
 */
function AvoidanceLayers(props: { nav: NavigationSettings; draft: SettingsDraft; set: Set }) {
  const { nav, draft, set } = props;
  const listed = navListedLayers(nav);
  const matrix = navAvoidanceMatrix(nav);
  const free = nextFreeNavAvoidanceLayer(nav);
  return (
    <>
      <div class="project-settings-list-head">
        <span>Avoidance layers</span>
        <span class="project-settings-hint">agent types and avoidance obstacles are on one layer; names are optional (up to 32)</span>
      </div>
      <div class="nav-layer-list" role="group" aria-label="Avoidance layer names">
        {listed.map((l) => {
          const named = isNavAvoidanceLayerNamed(nav, l);
          const users = named ? [] : navAvoidanceLayerUsers(nav, l);
          return (
            <div key={l} class="nav-layer" data-layer={l}>
              <span class="nav-layer-index">Layer {l}</span>
              <TextField value={nav.avoidanceLayers[l] ?? ""} placeholder="(unnamed)" label={`Avoidance layer ${l} name`} onCommit={(v) => set(v.trim() ? `Rename avoidance layer ${l} to ${v.trim()}` : `Clear avoidance layer ${l} name`, renameNavAvoidanceLayer(draft, l, v.trim()))} />
              {users.length > 0 && (
                <span class="nav-layer-warning" title="Unnamed layers still work; they show as Layer n">
                  unnamed, used by {users.join(", ")}
                </span>
              )}
              <button class="icon" aria-label={`Clear avoidance layer ${l} name`} title="Leave this layer unnamed (it still works)" disabled={!named} onClick={() => set(`Clear avoidance layer ${l} name`, renameNavAvoidanceLayer(draft, l, ""))}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button disabled={free < 0} onClick={() => set("Add avoidance layer", addNavAvoidanceLayer(draft))}>
        + Avoidance layer
      </button>

      <div class="project-settings-list-head">
        <span>Who avoids whom</span>
        <span class="project-settings-hint">rows: agent types on that layer; ticked: they all steer around the column's layer (agents and obstacles)</span>
      </div>
      {matrix.rows.length === 0 ? (
        <p class="project-settings-none">No agent types take part in avoidance (they need Walks and Avoids others on).</p>
      ) : (
        <div class="nav-avoidance-matrix-wrap">
          <table class="collision-matrix nav-avoidance-matrix" aria-label="Who avoids whom">
            <thead>
              <tr>
                <th />
                {matrix.columns.map((c) => (
                  <th key={c} scope="col" class="collision-col">
                    <span>{navAvoidanceLayerName(nav, c)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.layer}>
                  <th scope="row" title={row.types.join(", ")}>
                    {row.label}
                  </th>
                  {row.cells.map((cell) => {
                    const rowName = navAvoidanceLayerName(nav, row.layer);
                    const colName = navAvoidanceLayerName(nav, cell.layer);
                    return (
                      <td key={cell.layer}>
                        <input
                          type="checkbox"
                          aria-label={`${rowName} avoids ${colName}`}
                          title={cell.tip}
                          checked={cell.state === "on"}
                          indeterminate={cell.state === "mixed"}
                          aria-checked={cell.state === "mixed" ? "mixed" : cell.state === "on"}
                          onChange={(e) => {
                            const avoid = (e.currentTarget as HTMLInputElement).checked;
                            set(`${avoid ? "Avoid" : "Don't avoid"} ${colName} for ${rowName}`, setNavAvoidanceCell(draft, row.layer, cell.layer, avoid));
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="project-settings-hint">Layers no agent type is on (obstacles only) have no row: obstacles don't avoid anything.</p>
    </>
  );
}

const ADVANCED_NUMBERS: [path: string, label: string, step?: number][] = [
  ["tileSize", "Tile size (columns)", 8],
  ["chunkGrid", "Chunk grid (0 = none)", 1],
  ["build.minRegionArea", "Min region area", 1],
  ["build.mergeRegionArea", "Merge region area", 1],
  ["build.maxSimplificationError", "Max simplification error", 0.1],
  ["build.maxEdgeLength", "Max edge length", 1],
  ["build.vertsPerPoly", "Verts per poly", 1],
  ["build.detailSampleDistance", "Detail sample distance", 0.5],
  ["build.detailSampleMaxError", "Detail sample max error", 0.5],
  ["orientation.maxSurfaceDeg", "Max surface°", 5],
  ["orientation.groundCaptureDeg", "Ground capture°", 5],
  ["orientation.ceilingCaptureDeg", "Ceiling capture°", 5],
  ["orientation.coverageDeg", "Bin coverage°", 5],
  ["orientation.maxFoldDeg", "Max fold°", 5],
  ["flightHeadroomRadii", "Flight headroom (radii)", 0.5],
  ["flightAutoRefineMaxCells", "Auto refine max cells", 1000],
  ["runtime.maxPathsPerFrame", "Paths per frame (0 = 256)", 1],
  ["runtime.flowFieldMemoryMb", "Flow field memory (MB)", 8],
  ["runtime.congestionWindow", "Congestion window (s)", 0.5],
  ["runtime.congestionRepathInterval", "Congestion repath (s)", 0.5],
];

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

function Advanced(props: { nav: NavigationSettings; draft: SettingsDraft; set: Set }) {
  const { nav, draft, set } = props;
  const value = (path: string, label: string) => (v: unknown) => set(`Set navigation ${label}`, setNavValue(draft, path, v));
  return (
    <details class="nav-advanced">
      <summary>Advanced: voxels, tiles, build, flight, chunk grid</summary>
      <div class="tier-fields">
        <Cell label="Voxels">
          <Choice label="Voxel sizing" value={nav.voxels} options={["auto", "fixed"] as const} labels={{ auto: "Auto (per agent)", fixed: "Fixed" }} onChange={value("voxels", "voxel sizing")} />
        </Cell>
        {nav.voxels === "auto" ? (
          <Cell label="Cells per radius">
            <Num label="Cells per radius" value={nav.cellsPerRadius} step={0.5} onCommit={value("cellsPerRadius", "cells per radius")} />
          </Cell>
        ) : (
          <>
            <Cell label="Cell size">
              <Num label="Cell size" value={nav.cellSize} step={0.05} onCommit={value("cellSize", "cell size")} />
            </Cell>
            <Cell label="Cell height">
              <Num label="Cell height" value={nav.cellHeight} step={0.05} onCommit={value("cellHeight", "cell height")} />
            </Cell>
          </>
        )}
        <Cell label="Flight voxels">
          <Choice label="Flight voxel sizing" value={nav.flightVoxels} options={["auto", "fixed"] as const} labels={{ auto: "Auto (per agent)", fixed: "Fixed" }} onChange={value("flightVoxels", "flight voxel sizing")} />
        </Cell>
        {nav.flightVoxels === "auto" ? (
          <Cell label="Flight cells per radius">
            <Num label="Flight cells per radius" value={nav.flightCellsPerRadius} step={0.25} onCommit={value("flightCellsPerRadius", "flight cells per radius")} />
          </Cell>
        ) : (
          <Cell label="Flight cell size">
            <Num label="Flight cell size" value={nav.flightCellSize} step={0.25} onCommit={value("flightCellSize", "flight cell size")} />
          </Cell>
        )}
        <Cell label="Flight auto refine">
          <Choice label="Flight auto refine" value={nav.flightAutoRefine} options={["off", "x2", "x4", "x8"] as const} onChange={value("flightAutoRefine", "flight auto refine")} />
        </Cell>
        <Cell label="Fly only open to sky">
          <Check label="Fly only open to sky" checked={nav.flightOpenToSkyOnly} onChange={value("flightOpenToSkyOnly", "open-to-sky flight")} />
        </Cell>
        {ADVANCED_NUMBERS.map(([path, label, step]) => (
          <Cell key={path} label={label}>
            <Num label={label} value={getPath(nav, path) as number} step={step} onCommit={value(path, label.toLowerCase())} />
          </Cell>
        ))}
        <Cell label="Idle agents hold ground">
          <Check label="Idle agents hold ground" checked={nav.runtime.idleAgentsHoldGround} onChange={value("runtime.idleAgentsHoldGround", "idle agents holding ground")} />
        </Cell>
      </div>
      <p class="project-settings-hint">
        Surface rings: {nav.surfaceRings.map((r) => `${r.count} at ${r.tiltDeg}°`).join(", ") || "none"} (edit in project.json).
      </p>
      <button onClick={() => set("Reset navigation settings", resetNavigation(draft))} disabled={draft.navigation === undefined}>
        Reset to defaults
      </button>
    </details>
  );
}

/** The Navigation section's contents. `problems` are the section's parse problems. */
export function NavSettingsSection(props: { draft: SettingsDraft; problems: readonly string[]; set: Set; project: EditorProject }) {
  const { draft, set, project } = props;
  navBakeAllProgress.value; // re-render while Bake All runs
  const nav = navigationOf(draft);
  const progress = navBakeAllProgress.value;
  return (
    <div class={`project-settings-list project-settings-tiers nav-settings${props.problems.length ? " invalid" : ""}`} role="group" aria-label="Navigation settings">
      <div class="project-settings-list-head">
        <span>Agent types</span>
        <span class="project-settings-hint">walking types get a navmesh each (up to {MAX_NAV_AGENT_TYPES})</span>
      </div>
      {nav.agentTypes.map((t, i) => (
        <AgentCard key={t.id} nav={nav} t={t} i={i} draft={draft} set={set} count={nav.agentTypes.length} />
      ))}
      <button disabled={nav.agentTypes.length >= MAX_NAV_AGENT_TYPES} onClick={() => set("Add agent type", addNavAgentType(draft))}>
        + Agent type
      </button>

      <AvoidanceLayers nav={nav} draft={draft} set={set} />

      <div class="project-settings-list-head">
        <span>Areas</span>
        <span class="project-settings-hint">cost multipliers NavSurfaces and volumes can set (up to {MAX_NAV_AREAS})</span>
      </div>
      {nav.areas.length === 0 && <p class="project-settings-none">None: every surface is plain walkable</p>}
      {nav.areas.map((a, i) => (
        <div key={a.id} class="project-settings-item nav-area" data-area={a.id} title={`id ${a.id}`}>
          <input
            type="color"
            aria-label={`${a.name} colour`}
            value={navColorHex(a.color)}
            onChange={(e) => set(`Set ${a.name} colour`, setNavAreaValue(draft, i, "color", navHexColor((e.currentTarget as HTMLInputElement).value, a.color[3])))}
          />
          <TextField value={a.name} label={`Area ${i + 1} name`} onCommit={(v) => set(`Rename area to ${v.trim()}`, setNavAreaValue(draft, i, "name", v.trim()))} />
          <Num label={`${a.name} cost`} value={a.cost} step={0.5} onCommit={(n) => set(`Set ${a.name} cost`, setNavAreaValue(draft, i, "cost", n))} />
          <button class="icon" aria-label={`Remove area ${a.name}`} title="Remove this area (and agent types' costs for it)" onClick={() => set(`Remove area ${a.name}`, removeNavArea(draft, i))}>
            ×
          </button>
        </div>
      ))}
      <button disabled={nav.areas.length >= MAX_NAV_AREAS} onClick={() => set("Add area", addNavArea(draft))}>
        + Area
      </button>

      <Advanced nav={nav} draft={draft} set={set} />

      <div class="nav-bake-all">
        <button disabled={!project.canSave || progress !== null} title={project.canSave ? "Bake every NavChunk in every scene" : "Read-only project: open a project folder to bake"} onClick={() => void bakeAllFromPanel(project)}>
          Bake All
        </button>
        <span class="project-settings-hint" aria-live="polite">
          {progress ? `Baking ${progress}…` : project.canSave ? "Writes each scene's .nav.bin beside it." : "Read-only: open a project folder to bake."}
        </span>
      </div>
    </div>
  );
}
