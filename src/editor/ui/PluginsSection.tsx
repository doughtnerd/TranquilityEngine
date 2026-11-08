// The Project panel's Plugins category (ADR 0133): the first-party plugins with a checkbox each. Only
// what's off is stored (`plugins.disabled`), so new plugins default on. Turning off a plugin that others
// need asks first and turns them off too; turning one on turns on what it needs.
import { pluginManifests } from "../../plugins/editorApply";
import { pluginDependencies, pluginDependents, resolveEnabledPlugins, setPluginEnabled } from "../../plugins/enabled";
import { pluginTitle, type PluginManifest } from "../../plugins/manifest";
import { disabledPluginsOf, setDisabledPlugins, type SettingsDraft } from "../projectSettingsModel";
import { confirmInEditor } from "./ConfirmDialog";

type Set = (label: string, next: SettingsDraft) => void;

export function PluginsSection(props: { draft: SettingsDraft; set: Set }) {
  const { draft, set } = props;
  const manifests = pluginManifests();
  const title = (name: string) => {
    const m = manifests.find((x) => x.name === name);
    return m ? pluginTitle(m) : name;
  };
  const disabled = disabledPluginsOf(draft);
  const enabled = resolveEnabledPlugins(manifests, disabled);

  const toggle = async (m: PluginManifest, on: boolean) => {
    const { disabled: next, affected } = setPluginEnabled(manifests, disabled, m.name, on);
    if (!on && pluginDependents(manifests, m.name).length > 0) {
      const dependents = pluginDependents(manifests, m.name).filter((n) => enabled.has(n));
      if (dependents.length > 0) {
        const answer = await confirmInEditor({
          title: `Turn off ${pluginTitle(m)}`,
          message: `${dependents.length === 1 ? "A plugin needs" : `${dependents.length} plugins need`} ${pluginTitle(m)} and will turn off too.`,
          items: dependents.map(title),
          confirmLabel: "Turn off all",
          danger: false,
        });
        if (!answer.ok) return;
      }
    }
    const label = on ? `Enable plugin ${pluginTitle(m)}` : `Disable plugin ${pluginTitle(m)}`;
    set(on && affected.length > 0 ? `${label} and ${affected.map(title).join(", ")}` : label, setDisabledPlugins(draft, next));
  };

  return (
    <div class="plugins-section">
      <p class="project-settings-hint">
        A plugin that is off isn't loaded by the editor, Play or the exported game. Its data stays in your files: scenes show its components as missing and its files as generic assets, and
        everything returns when you turn it on again. The scene you have open updates at once; other open scenes update when you switch to them.
      </p>
      <ul class="plugins-list" aria-label="Plugins">
        {manifests.map((m) => {
          const on = enabled.has(m.name);
          const blockedBy = pluginDependencies(manifests, m.name).filter((d) => !enabled.has(d));
          const id = `ps-plugin-${m.name}`;
          return (
            <li key={m.name} class={`plugins-item${on ? "" : " off"}`}>
              <input id={id} type="checkbox" checked={on} data-plugin={m.name} onChange={(e) => void toggle(m, (e.currentTarget as HTMLInputElement).checked)} />
              <label for={id}>
                <span class="plugins-title">{pluginTitle(m)}</span>
                <span class="plugins-name">{m.name}</span>
                {m.description && <span class="plugins-description">{m.description}</span>}
                {!on && blockedBy.length > 0 && !disabled.includes(m.name) && <span class="plugins-description">Off because it needs {blockedBy.map(title).join(", ")}.</span>}
                {on && pluginDependencies(manifests, m.name).length > 0 && <span class="plugins-description">Needs {pluginDependencies(manifests, m.name).map(title).join(", ")}.</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
