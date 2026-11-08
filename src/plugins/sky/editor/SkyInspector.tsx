// The Inspector's view of a selected sky asset (ADR 0112, 0134): a look at it, and a way into the Sky panel.
import { fileName } from "../../../editor/assetBrowser";
import { LargePreview } from "../../../editor/ui/AssetPreview";
import { openSkyAsset } from "./skyAssets";

export function SkyInspector(props: { path: string }) {
  return (
    <div class="asset-inspector">
      <h3>{fileName(props.path)}</h3>
      <p class="hint">A procedural sky (ADR 0112). Use it as an Environment's map.</p>
      <LargePreview path={props.path} />
      <div class="asset-inspector-actions">
        <button class="primary" onClick={() => openSkyAsset(props.path)}>
          Edit in Sky panel
        </button>
      </div>
    </div>
  );
}
