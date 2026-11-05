import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { navigationOf } from "../../engine/editor";
import type { NavTickStats } from "../../engine/nav/runtime";
import { cleanNavOverlay, navOverlaySettings, updateNavOverlay } from "../navGizmo";
import { projectNavigation } from "../navBake";
import { currentProject } from "../state";
import { playing } from "../session";
import { playState } from "../state";
import "./navdebug.css";

/** Counters refresh this often while playing (not every frame). */
const REFRESH_MS = 250;
const MAX_WARNINGS = 50;

/** Warnings drained from the runtime this session, newest last (draining empties the runtime's own list). */
export const navWarnings = signal<string[]>([]);

/** Flatten a stats object to `path: number|boolean` rows (so counters the runtime adds later show up too). */
export function statRows(stats: unknown, prefix = ""): { name: string; value: string }[] {
  if (!stats || typeof stats !== "object") return [];
  const rows: { name: string; value: string }[] = [];
  for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") rows.push({ name, value: Number.isInteger(v) ? String(v) : v.toFixed(2) });
    else if (typeof v === "boolean") rows.push({ name, value: v ? "yes" : "no" });
    else if (v && typeof v === "object") rows.push(...statRows(v, name));
  }
  return rows;
}

interface Sample {
  stats: NavTickStats | null;
  world: string | null;
}

function sample(): Sample {
  const session = playing.peek();
  if (!session) return { stats: null, world: null };
  for (const h of session.engine.worlds()) {
    const world = session.engine._world(h.name);
    const nav = world && navigationOf(world);
    if (!nav) continue;
    try {
      const warnings = nav.runtime.drainWarnings();
      if (warnings.length > 0) navWarnings.value = [...navWarnings.peek(), ...warnings].slice(-MAX_WARNINGS);
      return { stats: nav.runtime.tickStats(), world: h.name };
    } catch {
      return { stats: null, world: h.name };
    }
  }
  return { stats: null, world: null };
}

/** Navigation counters while playing: agents, searches, slices, rebuilds, ms per stage, and the runtime's warnings (ADR 0065). */
export function NavDebugPanel() {
  const [s, setS] = useState<Sample>({ stats: null, world: null });
  const isPlaying = playState.value === "playing" && playing.value !== null;
  useEffect(() => {
    if (!isPlaying) return;
    setS(sample());
    const t = setInterval(() => setS(sample()), REFRESH_MS);
    return () => clearInterval(t);
  }, [isPlaying, playing.value]);
  if (!isPlaying) return null;
  if (!s.stats) return null;
  const rows = statRows(s.stats);
  const warnings = navWarnings.value;
  return (
    <section class="nav-debug" aria-label="Navigation">
      <h4>
        Navigation <span class="nav-world">{s.world}</span>
      </h4>
      <table class="nav-counters">
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {warnings.length > 0 && (
        <div class="nav-warnings" role="log" aria-label="Navigation warnings">
          <button class="link-button" onClick={() => (navWarnings.value = [])}>
            Clear
          </button>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The scene view popover's toggles: Navmesh, Links, Flight volume, the agent group, and the play-mode extras. */
export function NavOverlayForm() {
  const s = cleanNavOverlay(navOverlaySettings.value);
  const types = projectNavigation(currentProject.value).agentTypes;
  const check = (key: "navmesh" | "links" | "volume" | "landing" | "seams" | "paths" | "costs", label: string, title?: string) => (
    <label class="snap-row check" title={title}>
      <input type="checkbox" checked={s[key]} aria-label={label} onChange={(e) => updateNavOverlay({ [key]: (e.currentTarget as HTMLInputElement).checked })} />
      <span>{label}</span>
    </label>
  );
  return (
    <div class="snap-form nav-overlay-form">
      {check("navmesh", "Navmesh", "Polygon outlines, shared and chunk-face edges of the baked navmesh")}
      {check("links", "Links", "Fold and jump links (jumps as arcs)")}
      {check("volume", "Flight volume", "Flight leaves (heavy: capped)")}
      <label class="snap-row nav-group">
        <span>Agent group</span>
        <select aria-label="Agent group" value={s.group} onChange={(e) => updateNavOverlay({ group: Number((e.currentTarget as HTMLSelectElement).value) })}>
          {(types.length > 0 ? types : [{ id: "0", name: "Group 0" }]).map((t, i) => (
            <option key={t.id} value={i}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div class="nav-play-heading">While playing</div>
      {check("landing", "Landing links")}
      {check("seams", "Seams")}
      {check("paths", "Agent paths")}
      {check("costs", "Cost volumes", "Polygons whose cost a NavCostVolume changes: costlier, cheaper or excluded")}
    </div>
  );
}
