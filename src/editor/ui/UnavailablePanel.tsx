// The body of a panel whose type isn't registered (ADR 0174): its plugin is turned off, isn't in the
// project, or couldn't load. The panel keeps its tab, place and ×; this says what it was and which
// plugin brings it back.
import { allPluginManifests, projectPlugins } from "../../plugins/thirdPartyEditor";
import { pluginTitle } from "../../plugins/manifest";
import { showPanel } from "../layout/store";
import { projectSettingsCategory } from "../preferences";
import { Panel, usePanel } from "./panel/Panel";
import type { PanelInfo } from "../layout/model";

export function UnavailablePanel(props: { info?: PanelInfo }) {
  const { type, title } = usePanel();
  const info = props.info;
  const manifest = info?.plugin ? allPluginManifests().find((m) => m.name === info.plugin) : undefined;
  const problem = info?.plugin ? projectPlugins.value.problems.find((p) => p.plugin === info.plugin) : undefined;
  const plugin = manifest ? pluginTitle(manifest) : (info?.pluginTitle ?? info?.plugin);
  return (
    <Panel class="unavailable-panel">
      <div class="unavailable-panel-message" role="status">
        <p>
          <strong>{title}</strong> isn't available.
        </p>
        {!info?.plugin ? (
          <p>No plugin in this project provides the panel “{type}”. It may come from a plugin that was removed.</p>
        ) : problem ? (
          <p>
            It comes from the plugin <strong>{plugin}</strong> ({info.plugin}), which couldn't load: {problem.message}
          </p>
        ) : manifest ? (
          <>
            <p>
              It comes from the plugin <strong>{plugin}</strong> ({info.plugin}), which is turned off for this project. Turn it on in Project Settings › Plugins to bring this panel back.
            </p>
            <button
              onClick={() => {
                projectSettingsCategory.value = "Plugins";
                showPanel("project");
              }}
            >
              Open Plugins settings
            </button>
          </>
        ) : (
          <p>
            It comes from the plugin <strong>{plugin}</strong> ({info.plugin}), which isn't in this project. Add the plugin to the project's plugins/ folder or its npm packages to bring this panel back.
          </p>
        )}
        <p class="unavailable-panel-hint">You can move or close this panel like any other.</p>
      </div>
    </Panel>
  );
}
