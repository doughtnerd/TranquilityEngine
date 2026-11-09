import { editor, LargePreview } from "../../../editor/sdk";
// The Inspector's view of a selected environment map or cubemap (ADR 0061, 0140): no settings to edit,
// just a look at it.

export function EnvironmentAssetInspector(props: { path: string }) {
  return (
    <div class="asset-inspector">
      <h3>{editor.assets.fileName(props.path)}</h3>
      <p class="hint">
        {editor.assets.kindOf(props.path) === "cubemap"
          ? "Cubemap (ADR 0113): six images as a skybox. Use it as an Environment's map."
          : "Environment map. An Environment component lights the scene with it and can show it as the sky."}
      </p>
      <LargePreview path={props.path} />
    </div>
  );
}
