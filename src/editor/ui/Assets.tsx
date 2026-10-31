import { isScenePath } from "../projects";
import { switchScene } from "../session";
import { currentProject, openScene } from "../state";

/** The project's files. Scenes and prefabs open on click; other assets are listed for reference. */
export function AssetsPanel() {
  const project = currentProject.value;
  if (!project) return <p class="empty">No project open</p>;
  const open = openScene.value?.path;
  const scenes = project.files.filter(isScenePath);
  const others = project.files.filter((f) => !isScenePath(f) && f !== "project.json");
  return (
    <div class="assets-body">
      <div class="asset-group">
        <h4>Scenes and prefabs</h4>
        <ul class="asset-list">
          {scenes.map((path) => (
            <li key={path}>
              <button class={`asset scene${path === open ? " open" : ""}`} title={`Open ${path}`} onClick={() => void switchScene(path)}>
                {path}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div class="asset-group">
        <h4>Other assets</h4>
        <ul class="asset-list">
          {others.map((path) => (
            <li key={path} class="asset other">
              {path}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
