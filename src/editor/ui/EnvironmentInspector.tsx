// Under an Environment's fields in the Inspector (ADR 0112, 0131): "Edit sky" when its map is a sky
// asset in the project and the Sky plugin (ADR 0134) is there to open it.
import { isSkyPath } from "../../engine/sky/skyFormat";
import { assetKind } from "../assetBrowser";
import { registeredKind } from "../assetKindLookup";
import { assetRefTarget } from "../assetReferences";
import { currentProject } from "../state";
import { sectionField, type InspectorSectionProps } from "./inspectorSections";

export function EnvironmentSection({ info }: InspectorSectionProps) {
  const path = assetRefTarget(String(sectionField(info, "map") ?? ""));
  if (!isSkyPath(path) || !currentProject.value?.files.includes(path)) return null;
  const kind = registeredKind(assetKind(path));
  if (!kind?.open) return null;
  return (
    <div class="prefab-actions">
      <button type="button" onClick={() => kind.open!(path)} title={`Open ${path} in the Sky panel`}>
        Edit sky
      </button>
    </div>
  );
}
