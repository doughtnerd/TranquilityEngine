import { signal } from "@preact/signals";
import {
  addAssetToScene,
  assetKind,
  buildFolderTree,
  canAddToScene,
  fileName,
  findFolder,
  folderOf,
  searchFiles,
  type AssetKind,
  type Folder,
} from "../assetBrowser";
import { switchScene } from "../session";
import { currentProject, docVersion, openScene, playState, sceneCamera, selection, status } from "../state";
import "./assets.css";

/** Open folder (project-relative, "" = root), search text and the selected tile. */
const folderPath = signal("");
const query = signal("");
const selectedAsset = signal<string | null>(null);

const KIND_LABELS: Record<AssetKind, string> = { scene: "Scene", prefab: "Prefab", image: "Image", audio: "Audio", json: "JSON", other: "File" };

/**
 * The project's files (ADR 0022): a folder tree, a grid of tiles with image thumbnails, and
 * search across folders. Click selects a tile, double-click opens scenes and prefabs, and the +
 * button adds a prefab instance or a sprite for an image to the open scene.
 */
export function AssetsPanel() {
  docVersion.value; // the project's file list can change after saves
  const project = currentProject.value;
  if (!project) return <p class="empty">No project open</p>;
  const tree = buildFolderTree(project.files);
  const folder = findFolder(tree, folderPath.value) ?? tree;
  const searching = query.value.trim() !== "";
  const files = searching ? searchFiles(project.files, query.value) : folder.files;
  return (
    <div class="asset-browser">
      <nav class="asset-tree" aria-label="Folders">
        <ul role="tree">
          <FolderItem folder={tree} label={project.name} depth={0} />
        </ul>
      </nav>
      <div class="asset-main">
        <div class="asset-bar">
          <span class="asset-crumb">{searching ? `Results for “${query.value.trim()}”` : folder.path === "" ? project.name : folder.path}</span>
          <input
            type="search"
            class="asset-search"
            placeholder="Search assets"
            aria-label="Search assets"
            value={query.value}
            onInput={(e) => (query.value = (e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        {files.length === 0 ? (
          <p class="empty">{searching ? "No matching assets" : "This folder has no assets"}</p>
        ) : (
          <ul class="asset-grid" role="listbox" aria-label="Assets">
            {files.map((path) => (
              <AssetTile key={path} path={path} showFolder={searching} url={project.assets.get(path)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FolderItem(props: { folder: Folder; label: string; depth: number }) {
  const { folder, label, depth } = props;
  const current = !query.value.trim() && folderPath.value === folder.path;
  return (
    <li role="treeitem" aria-selected={current}>
      <button
        class={`asset-folder${current ? " current" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => {
          folderPath.value = folder.path;
          query.value = "";
        }}
      >
        {label}
      </button>
      {folder.folders.length > 0 && (
        <ul role="group">
          {folder.folders.map((f) => (
            <FolderItem key={f.path} folder={f} label={f.name} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function AssetTile(props: { path: string; url: unknown; showFolder: boolean }) {
  const { path, url, showFolder } = props;
  const kind = assetKind(path);
  const open = openScene.value?.path === path;
  const selected = selectedAsset.value === path;
  const opens = kind === "scene" || kind === "prefab";
  const canAdd = canAddToScene(path) && !!openScene.value && playState.value === "edit" && openScene.value.path !== path;
  return (
    <li
      class={`asset-tile kind-${kind}${selected ? " selected" : ""}${open ? " open" : ""}`}
      role="option"
      aria-selected={selected}
      title={`${path}${opens ? " (double-click to open)" : ""}`}
      onClick={() => (selectedAsset.value = path)}
      onDblClick={() => opens && void switchScene(path)}
    >
      <div class="asset-thumb">
        {kind === "image" && typeof url === "string" ? <img src={url} alt="" draggable={false} /> : <span class="asset-kind">{KIND_LABELS[kind]}</span>}
      </div>
      <span class="asset-name">{fileName(path)}</span>
      {showFolder && <span class="asset-folder-hint">{folderOf(path) || "/"}</span>}
      {canAddToScene(path) && (
        <button
          class="asset-add"
          disabled={!canAdd}
          title={canAdd ? `Add ${fileName(path)} to the scene` : "Open a scene (and stop playing) to add assets"}
          aria-label={`Add ${fileName(path)} to the scene`}
          onClick={(e) => {
            e.stopPropagation();
            addToScene(path);
          }}
        >
          +
        </button>
      )}
    </li>
  );
}

function addToScene(path: string): void {
  const scene = openScene.value;
  if (!scene) return;
  try {
    const focus = sceneCamera.value?.focusPoint;
    const id = addAssetToScene(scene, path, selection.value, focus ? [focus.x, focus.y, focus.z] : [0, 0, 0]);
    selection.value = id;
    status.value = { kind: "info", text: `Added ${fileName(path)} to ${fileName(scene.path)}` };
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't add ${fileName(path)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
