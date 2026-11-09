// The Scene toolbar's navigation overlay popover (ADR 0065), a toolbar item the Navigation plugin registers (ADR 0142):
// what its scene-view overlay tool (`navGizmo.ts`) draws.
import { cleanNavOverlay, navOverlaySettings, updateNavOverlay } from "./navGizmo";
import { projectNavigation } from "./navBake";
import { editor } from "../../../editor/sdk";
import "./navOverlay.css";

/** The scene view popover's toggles: Navmesh, Links, Flight volume, the agent group, and the play-mode extras. */
export function NavOverlayForm() {
  const s = cleanNavOverlay(navOverlaySettings.value);
  const types = projectNavigation(editor.project.current).agentTypes;
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
