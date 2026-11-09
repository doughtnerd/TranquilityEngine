// Under an Environment's fields in the Inspector (ADR 0112, 0131): "Edit sky" when its map is a sky
// asset in the project and the Sky plugin (ADR 0134) is there to open it.
import { isSkyPath } from "../../engine/sky/skyFormat";
import { assetKindFor } from "../assetKinds";
import { currentProject } from "../state";
import { sectionField, type InspectorSectionProps } from "./inspectorSections";

export function EnvironmentSection({ info }: InspectorSectionProps) {
  const path = String(sectionField(info, "map") ?? "").replace(/^asset:/, "");
  if (!isSkyPath(path) || !currentProject.value?.files.includes(path)) return null;
  const kind = assetKindFor(path);
  if (!kind?.open) return null;
  return (
    <div class="prefab-actions">
      <button type="button" onClick={() => kind.open!(path)} title={`Open ${path} in the Sky panel`}>
        Edit sky
      </button>
    </div>
  );
}
