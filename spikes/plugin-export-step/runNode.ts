// SPIKE (a): the CLI's side. node:fs lives only here, behind `read`; the steps never see it.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProject } from "../../src/server/project";
import { runExportSteps } from "./exportStep";
import { loadExportSteps } from "./loadSteps";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("./fixtures/project", import.meta.url));
  const debug = args.includes("--debug");
  const project = await readProject(dir);
  // `import ... from "myco"` in an export entry: a real host would pass the engine (the server does, `src/server/project.ts`).
  const loaded = await loadExportSteps({ json: project.json, scripts: project.scripts, files: project.files, disabled: project.settings.plugins?.disabled }, {});
  console.log("enabled third-party plugins:", loaded.plan.loaded.map((p) => p.manifest.name));
  console.log("steps:", loaded.steps.map((s) => s.plugin));
  console.log("export-only files that planWebBuild would ALSO compile into the game:", loaded.exportOnlyFilesInGameCode);
  if (loaded.problems.length > 0) {
    console.error("problems:\n" + loaded.problems.map((p) => `  - ${p}`).join("\n"));
    return 1;
  }
  const result = await runExportSteps({
    steps: loaded.steps,
    values: { "acme.stamp": { label: "Node CLI" } },
    debug,
    platform: "web",
    project: { settings: project.settings as Record<string, unknown>, files: project.files, json: project.json, read: (path) => readFile(join(resolve(dir), ...path.split("/")), "utf8") },
    log: (l) => console.log("log:", l),
  });
  console.log("game.json slices:", JSON.stringify(result.slices));
  console.log("files:", [...result.files].map(([p, c]) => `${p} = ${JSON.stringify(c)}`));
  return 0;
}
