// SPIKE (b): the editor's side of Export, as far as it can be run without a browser. The editor holds a project as
// Maps (`project.scripts`, `jsonFiles(project)`, `project.files`) and reads bytes through its FileSystem / asset URLs;
// there is no node:fs. This test feeds the SAME `loadExportSteps` only such Maps and a Map-backed `read`, and checks
// that the export code's imports are host-neutral. What it can't show: MemoryTarget importing `blob:` URLs (the editor
// path) vs `data:` URLs (Node): vitest here is Node, and no jsdom/happy-dom is installed. See README [unverified].
import { describe, expect, it } from "vitest";
import { compileScript } from "../../src/projectCode/compile";
import { runExportSteps } from "./exportStep";
import { loadExportSteps } from "./loadSteps";

const stamp = `export const stampText = (g: string, l: string) => l + ":" + g;`;
const entry = (extra = "") => `import type { ExportStep } from "myco";
import { stampText } from "../shared/stamp";
${extra}
export default { options: [{ key: "label", label: "L", type: "string", default: "x" }],
  async run(ctx) { return { manifest: { t: stampText("g", ctx.options.label as string), n: String(await ctx.project.read("a.json")).length }, files: new Map([["f.txt", "hi"]]) }; } } satisfies ExportStep;`;

const project = (files: Record<string, string>) => {
  const scripts = new Map(Object.entries(files).filter(([p]) => p.endsWith(".ts")));
  const json = new Map(Object.entries(files).filter(([p]) => p.endsWith(".json")));
  return { scripts, json, files: Object.keys(files) };
};

const base = {
  "project.json": "{}",
  "a.json": '{"k":1}',
  "plugins/p/plugin.json": JSON.stringify({ name: "acme.p", version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/i.ts", export: "export/i.ts" }),
  "plugins/p/runtime/i.ts": "export function activate() {}",
  "plugins/p/shared/stamp.ts": stamp,
};

describe("export steps from in-memory project data (the editor's shape)", () => {
  it("loads and runs a third-party TypeScript step from Maps only", async () => {
    const p = project({ ...base, "plugins/p/export/i.ts": entry() });
    const loaded = await loadExportSteps({ json: p.json, scripts: p.scripts, files: p.files }, {});
    expect(loaded.problems).toEqual([]);
    const memory = new Map([["a.json", '{"k":1}']]);
    const out = await runExportSteps({
      steps: loaded.steps, debug: false, platform: "web",
      project: { settings: {}, files: p.files, json: p.json, read: async (path) => memory.get(path) ?? Promise.reject(new Error("not in the project")) },
    });
    expect(out.slices["acme.p"]).toEqual({ t: "x:g", n: 7 });
    expect([...out.files.keys()]).toEqual(["plugins/acme.p/f.txt"]);
  });

  it("a disabled plugin's step doesn't load, so it can't run", async () => {
    const p = project({ ...base, "plugins/p/export/i.ts": entry() });
    const loaded = await loadExportSteps({ json: p.json, scripts: p.scripts, files: p.files, disabled: ["acme.p"] }, {});
    expect(loaded.steps.map((s) => s.plugin)).not.toContain("acme.p");
  });

  it("a syntax error in the export entry is a problem naming the file (stops the export, like a script)", async () => {
    const p = project({ ...base, "plugins/p/export/i.ts": "export default {" });
    const loaded = await loadExportSteps({ json: p.json, scripts: p.scripts, files: p.files }, {});
    expect(loaded.problems.join("\n")).toContain("plugins/p/export/i.ts");
  });

  it("a step may not escape its folder in the build", async () => {
    const step = { run: () => ({ files: new Map([["../game.json", "x"]]) }) };
    await expect(runExportSteps({ steps: [{ plugin: "acme.p", step }], debug: false, platform: "web", project: { settings: {}, files: [], json: new Map(), read: async () => "" } })).rejects.toThrow(/stay inside/);
  });

  it("debug-only options exist only in debug builds", async () => {
    const p = project({ ...base, "plugins/p/export/i.ts": entry() });
    const loaded = await loadExportSteps({ json: p.json, scripts: p.scripts, files: p.files }, {});
    const input = { steps: loaded.steps, values: { "myco.subtitles": { captionLog: true } }, platform: "web" as const, project: { settings: {}, files: p.files, json: p.json, read: async () => "{}" } };
    expect((await runExportSteps({ ...input, debug: false })).files.has("plugins/myco.subtitles/captions.log")).toBe(false);
    expect((await runExportSteps({ ...input, debug: true })).files.has("plugins/myco.subtitles/captions.log")).toBe(true);
  });
});

describe("host neutrality guard (what a lint at link time could enforce)", () => {
  const importsOf = async (source: string) => (await compileScript("plugins/p/export/i.ts", source, { sourceMap: false }) as { imports: { specifier: string }[] }).imports.map((i) => i.specifier);

  it("the third-party fixture imports nothing host-specific", async () => {
    expect(await importsOf(entry())).toEqual(["../shared/stamp"]); // `import type "myco"` is erased
  });

  it("node: specifiers are visible, so a host (or `myco plugin check`) can refuse them", async () => {
    const specs = await importsOf(entry(`import { readFile } from "node:fs/promises"; void readFile;`));
    expect(specs.filter((s) => s.startsWith("node:"))).toEqual(["node:fs/promises"]);
  });
});
