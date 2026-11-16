// The Project panel's Plugins category (ADR 0133, 0139): the first-party plugins, then the project's
// third-party ones (from plugins/ and npm packages), with a checkbox each, and the refused ones. Only
// what's off is stored (`plugins.disabled`), so new plugins default on. Turning off a plugin that others
// need asks first and turns them off too; turning one on turns on what it needs. The switch is
// `switchPlugin` (pluginSwitch.ts); this view draws the list and the dialogs.
import { allPluginManifests, projectPlugins } from "../../plugins/thirdPartyEditor";
import { migrateDisabledPlugins, pluginDependencies, resolveEnabledPlugins } from "../../plugins/enabled";
import { pluginTitle, type PluginManifest } from "../../plugins/manifest";
import { disabledPluginsOf, type SettingsDraft } from "../projectSettingsModel";
import { switchPlugin, type PluginSwitchAnswer, type PluginSwitchQuestion } from "../pluginSwitch";
import { confirmInEditor } from "./ConfirmDialog";
import { panelTitle } from "../layout/model";

type Set = (label: string, next: SettingsDraft) => void;

export function PluginsSection(props: { draft: SettingsDraft; set: Set }) {
  const { draft, set } = props;
  const manifests = allPluginManifests();
  const third = projectPlugins.value;
  const sourceOf = (name: string) => {
    const p = third.usable.find((x) => x.manifest.name === name);
    return !p ? null : p.source.kind === "project" ? `${p.source.folder}/` : `npm: ${p.source.package}`;
  };
  const title = (name: string) => {
    const m = manifests.find((x) => x.name === name);
    return m ? pluginTitle(m) : name;
  };
  const disabled = migrateDisabledPlugins(disabledPluginsOf(draft)); // old names (myco.physics2d) read as their new plugin (ADR 0137)
  const enabled = resolveEnabledPlugins(manifests, disabled);

  // The switch itself is an operation (pluginSwitch.ts); this only words its questions as dialogs.
  const ask = async (q: PluginSwitchQuestion): Promise<PluginSwitchAnswer> => {
    const heading = `Turn off ${title(q.plugin)}`;
    if (q.kind === "dependents") {
      const n = q.dependents.length;
      const answer = await confirmInEditor({
        title: heading,
        message: `${n === 1 ? "A plugin needs" : `${n} plugins need`} ${title(q.plugin)} and will turn off too.`,
        items: q.dependents.map(title),
        confirmLabel: "Turn off all",
        danger: false,
      });
      return { proceed: answer.ok };
    }
    // Layouts showing the panels of the plugins turning off (ADR 0174): keep them as unavailable panels, or remove them.
    const fixed = q.layouts.filter((l) => !l.writable);
    const answer = await confirmInEditor({
      title: heading,
      message:
        `${q.layouts.length === 1 ? "A layout shows" : `${q.layouts.length} layouts show`} panels from ${q.turningOff.length === 1 ? "this plugin" : "these plugins"}. ` +
        "Kept, they stay where they are and say which plugin brings them back; removed, saved layouts get a new version without them (the old one stays in Manage Layouts)." +
        (fixed.length > 0 ? ` Read-only project layouts keep them: ${fixed.map((l) => l.name).join(", ")}.` : ""),
      items: q.layouts.map((l) => `${l.name}: ${l.types.map((t) => panelTitle(t)).join(", ")}`),
      optionLabel: "Remove these panels from the layouts",
      confirmLabel: "Turn off",
      danger: false,
    });
    return answer.ok ? { proceed: true, removePanels: answer.option } : { proceed: false };
  };
  const toggle = (m: PluginManifest, on: boolean) => switchPlugin({ manifests, draft, name: m.name, on, ask, edit: set });

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
                <span class="plugins-name">
                  {m.name}
                  {sourceOf(m.name) && ` · ${m.version} · ${sourceOf(m.name)}`}
                </span>
                {m.description && <span class="plugins-description">{m.description}</span>}
                {!on && blockedBy.length > 0 && !disabled.includes(m.name) && <span class="plugins-description">Off because it needs {blockedBy.map(title).join(", ")}.</span>}
                {on && pluginDependencies(manifests, m.name).length > 0 && <span class="plugins-description">Needs {pluginDependencies(manifests, m.name).map(title).join(", ")}.</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {third.problems.length > 0 && (
        <>
          <p class="project-settings-hint">Plugins that can't load:</p>
          <ul class="plugins-list plugins-problems" aria-label="Plugin problems">
            {third.problems.map((p) => (
              <li key={`${p.where}:${p.message}`} class="plugins-item off">
                <span class="plugins-title">{p.plugin}</span>
                <span class="plugins-name">{p.where}</span>
                <span class="plugins-description">{p.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p class="project-settings-hint">
        Third-party plugins come from the project's plugins/ folder and from npm packages that mark themselves as Myco plugins. They run with the same access as your scripts, so only add
        plugins you trust.
      </p>
    </div>
  );
}
