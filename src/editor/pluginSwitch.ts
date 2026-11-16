// Turning a plugin on or off from the Project settings (ADR 0133, 0139, 0174), as one operation the
// Plugins category only draws dialogs for. Off asks first when enabled plugins need it (they turn off
// too), then when layouts show panels of the plugins turning off (keep them as unavailable panels, or
// remove them: saved layouts get a new version without them); on turns on what the plugin needs, no
// questions. The edit is one project-settings draft edit (one undo step), made last, after every answer.
import { migrateDisabledPlugins, pluginDependents, resolveEnabledPlugins, setPluginEnabled } from "../plugins/enabled";
import { pluginTitle, type PluginManifest } from "../plugins/manifest";
import { layoutsWithPanels, pluginPanelTypes, removePanelsFromLayouts, type LayoutWithPanels } from "./layout/savedStore";
import { disabledPluginsOf, setDisabledPlugins, type SettingsDraft } from "./projectSettingsModel";

/** What turning a plugin off asks, in this order; each is asked only when it applies. Names are plugin names. */
export type PluginSwitchQuestion =
  /** Enabled plugins that need `plugin` (directly or not) and will turn off with it. */
  | { kind: "dependents"; plugin: string; dependents: string[] }
  /**
   * Layouts (the working one first) showing panels of `turningOff` (the plugin and its enabled dependents).
   * Layouts that aren't `writable` (project layouts in a read-only project) keep the panels whatever the answer.
   */
  | { kind: "layouts"; plugin: string; turningOff: string[]; layouts: LayoutWithPanels[] };

/** `proceed: false` cancels the whole switch: nothing changes. `removePanels` answers the layouts question (default keep). */
export type PluginSwitchAnswer = { proceed: false } | { proceed: true; removePanels?: boolean };

export interface PluginSwitchRequest {
  /** Every plugin the project could load (first-party and third-party). */
  manifests: readonly PluginManifest[];
  /** The project settings draft before the switch. */
  draft: SettingsDraft;
  name: string;
  on: boolean;
  ask: (question: PluginSwitchQuestion) => Promise<PluginSwitchAnswer>;
  /** Makes the draft edit (`label` names it for undo). Called at most once, after every question. */
  edit: (label: string, next: SettingsDraft) => void;
}

/**
 * Turn `name` on or off: ask what applies, remove panels from layouts when asked to, then make the edit.
 * Resolves true when the edit was made, false when a question was cancelled (nothing changed).
 */
export async function switchPlugin(req: PluginSwitchRequest): Promise<boolean> {
  const { manifests, draft, name, on, ask, edit } = req;
  const title = (n: string) => {
    const m = manifests.find((x) => x.name === n);
    return m ? pluginTitle(m) : n;
  };
  const disabled = migrateDisabledPlugins(disabledPluginsOf(draft)); // old names (myco.physics2d) read as their new plugin (ADR 0137)
  const { disabled: next, affected } = setPluginEnabled(manifests, disabled, name, on);

  if (!on) {
    const enabled = resolveEnabledPlugins(manifests, disabled);
    const dependents = pluginDependents(manifests, name).filter((n) => enabled.has(n));
    if (dependents.length > 0 && !(await ask({ kind: "dependents", plugin: name, dependents })).proceed) return false;
    const turningOff = [name, ...dependents];
    const types = pluginPanelTypes(turningOff);
    const layouts = types.length > 0 ? layoutsWithPanels(types) : [];
    if (layouts.length > 0) {
      const answer = await ask({ kind: "layouts", plugin: name, turningOff, layouts });
      if (!answer.proceed) return false;
      if (answer.removePanels) await removePanelsFromLayouts(types, `Removed ${turningOff.map(title).join(", ")} panels`);
    }
  }

  const label = `${on ? "Enable" : "Disable"} plugin ${title(name)}`;
  edit(on && affected.length > 0 ? `${label} and ${affected.map(title).join(", ")}` : label, setDisabledPlugins(draft, next));
  return true;
}
