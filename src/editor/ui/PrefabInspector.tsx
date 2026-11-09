// A prefab in the Inspector (ADR 0061): the core `prefab` kind's `inspector` (ADR 0143). No settings
// to edit here, just a look at it.
import { fileName } from "../assetBrowser";
import { LargePreview } from "./AssetPreview";
import "./assetInspector.css";

export function PrefabInspector(props: { path: string }) {
  return (
    <div class="asset-inspector">
      <h3>{fileName(props.path)}</h3>
      <p class="hint">Prefab. Drag it into the Hierarchy or the scene view to place a copy.</p>
      <LargePreview path={props.path} />
    </div>
  );
}
