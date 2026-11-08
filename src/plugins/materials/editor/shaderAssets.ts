// New Shader (ADR 0106): a `*.shader.json` shader asset with its WGSL and GLSL code beside it.
// The `shader` asset kind's `create` (ADR 0134): the Materials plugin owns `.shader.json`.
import { defaultShaderAsset, formatShaderAsset, type ShaderAsset } from "../../../engine/scene/shaderAsset";
import { fileName } from "../../../editor/assetBrowser";
import { freePath } from "../../../editor/assetOps";
import { errorStatus } from "../../../editor/messages";
import { currentProject, docVersion, status } from "../../../editor/state";

/** WGSL starter for New Shader: a `Tint` property sets the base colour. */
export const NEW_SHADER_WGSL = `// Properties are uniforms.<Name>. Keywords are #ifdef KW_<NAME>.
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
}
`;

/** GLSL ES 3.0 starter for New Shader, the same surface as the WGSL one. */
export const NEW_SHADER_GLSL = `// Properties are bare names. Keywords are #ifdef KW_<NAME>.
void surface(MycoSurfaceInput s, inout MycoSurface o) {
  o.baseColor = Tint.rgb;
}
`;

/** Where New Shader goes by default: `shaders/` if the project has it, else the folder given. */
export function shaderFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("shaders") ? "shaders" : folder;
}

/**
 * Create `New Shader.shader.json` (or `New Shader 2`…) with `New Shader.wgsl` and `New Shader.glsl`
 * beside it: a minimal surface shader with a `Tint` colour property. Returns the JSON's path, or
 * null if the project is read-only or writing failed.
 */
export async function createShader(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add shaders.` };
    return null;
  }
  const dir = shaderFolder(folder);
  const at = (stem: string, ext: string) => (dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`);
  const free = (stem: string) => [".shader.json", ".wgsl", ".glsl"].every((ext) => freePath(project, dir, `${stem}${ext}`) === at(stem, ext));
  let stem = "New Shader";
  for (let n = 2; !free(stem); n++) stem = `New Shader ${n}`;
  const path = at(stem, ".shader.json");
  const shader: ShaderAsset = {
    ...defaultShaderAsset(),
    properties: [{ name: "Tint", type: "color", value: "#ffffff" }],
    wgsl: { file: `asset:${at(stem, ".wgsl")}` },
    glsl: { file: `asset:${at(stem, ".glsl")}` },
  };
  try {
    await project.writeFile(at(stem, ".wgsl"), NEW_SHADER_WGSL);
    await project.writeFile(at(stem, ".glsl"), NEW_SHADER_GLSL);
    await project.writeText(path, formatShaderAsset(shader));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)} with its WGSL and GLSL code.` };
  return path;
}
