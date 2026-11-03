// New projects (ADR 0038): a folder with `project.json`, a main scene with a camera, `scripts/`
// and the scripting files external code editors need (ADR 0030).
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projects";
import { writeScriptingFiles } from "./scriptingSetup";

export type ProjectTemplate = "2d" | "3d";

export const PROJECT_TEMPLATES: readonly { id: ProjectTemplate; label: string; hint: string }[] = [
  { id: "2d", label: "Empty 2D", hint: "An orthographic camera and 2D physics" },
  { id: "3d", label: "Empty 3D", hint: "A perspective camera, a sun and 3D physics" },
];

/** Why `name` can't name a project folder, or null if it can. */
export function whyNotProjectName(name: string): string | null {
  const n = name.trim();
  if (n === "") return "Give the project a name.";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) return 'A project name can\'t contain < > : " / \\ | ? or *.';
  if (/^\.+$/.test(n) || /[. ]$/.test(n)) return "A project name can't end with a dot or a space.";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) return `"${n}" is reserved on Windows; choose another name.`;
  if (n.length > 100) return "That name is too long.";
  return null;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The new project's `project.json`: every setting written out, so the Project panel and a text editor both show them. */
export function newProjectJson(name: string, template: ProjectTemplate): string {
  return json({
    name: name.trim(),
    display: { width: 1280, height: 720, backgroundColor: template === "2d" ? "#1d1f24" : "#20242c" },
    time: { fixedDeltaTime: 1 / 60, maxSubSteps: 5, maxFrameTime: 0.25 },
    physics: { gravity: [0, -9.81], layers: ["Default"] },
    render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
    autoload: [],
  });
}

/** The new project's main scene: a camera (orthographic in 2D; perspective with a sun in 3D, ADR 0043). */
export function newMainScene(template: ProjectTemplate): string {
  const camera =
    template === "2d"
      ? [
          { type: "engine.Transform", data: { position: [0, 0, 10] } },
          { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5 } },
        ]
      : [
          { type: "engine.Transform", data: { position: [0, 2, 10] } },
          { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 60 } },
        ];
  const sun = {
    id: "sun",
    name: "Sun",
    components: [
      { type: "engine.Transform", data: { position: [0, 5, 0], rotation: [-50, 30, 0] } },
      { type: "engine.Light", data: { type: "directional", castShadows: true } },
    ],
  };
  const ambient = { id: "ambient", name: "Ambient Light", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "ambient", intensity: 0.35 } }] };
  return json({
    format: "myco.scene@1",
    settings: { physics: template === "2d" ? "2d" : "3d" },
    nodes: [{ id: "camera", name: "Camera", components: camera }, ...(template === "3d" ? [sun, ambient] : [])],
  });
}

const GITIGNORE = "# Myco Engine: edit history and engine declarations, rewritten by the editor\n.myco/\n";

/**
 * Create a project in the folder `root` (made if missing; it must not hold a project or other
 * files already). `declarations` are the engine's `.d.ts` files for the scripting setup; without
 * them only `scripts/` and `tsconfig.json`'s folder is made, and the editor writes the rest when it
 * opens the project.
 */
export async function scaffoldProject(
  fs: FileSystem,
  root: string,
  options: { name: string; template: ProjectTemplate; declarations?: Readonly<Record<string, string>> },
): Promise<void> {
  const problem = whyNotProjectName(options.name);
  if (problem) throw new Error(problem);
  if (await fs.exists(root)) {
    const entries = (await fs.list(root)).filter((e) => !e.name.startsWith("."));
    if (entries.length > 0) throw new Error(`"${root}" already exists and isn't empty; choose another name or folder.`);
  }
  await fs.mkdir(root);
  await fs.mkdir(joinPath(root, "scenes"));
  await fs.mkdir(joinPath(root, "scripts"));
  await fs.writeText(joinPath(root, "project.json"), newProjectJson(options.name, options.template));
  await fs.writeText(joinPath(root, "scenes/main.scene.json"), newMainScene(options.template));
  await fs.writeText(joinPath(root, ".gitignore"), GITIGNORE);
  if (options.declarations) await writeScriptingFiles(fs, root, options.declarations);
}
