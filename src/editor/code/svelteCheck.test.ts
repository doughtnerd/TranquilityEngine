// Svelte components type-checked as the Code panel's TypeScript service checks them (ADR 0432): the generated
// TypeScript beside the engine's declarations and the project's files, with the scripts' settings, through the
// TypeScript compiler here (Monaco's worker runs the same checker in the editor).
import { readFileSync } from "node:fs";
import ts from "typescript";
import declarations from "virtual:myco-types";
import { describe, expect, it } from "vitest";
import { compilerOptions, SCRIPT_CHECK } from "../../scriptCompiler.mjs";
import { componentTypeScript, generatedPathOf, SVELTE_CHECK_TYPES, type ComponentRange } from "./svelteCheck";

/** A type error in a project file, as the Code panel shows it: in the component for a generated file. */
interface Found extends Partial<ComponentRange> {
  readonly path: string;
  readonly message: string;
}

/** Type-check `project` (project path → text): components through `componentTypeScript`, the rest as they are. */
async function check(project: Record<string, string>): Promise<Found[]> {
  const files = new Map<string, string>();
  for (const [path, text] of SVELTE_CHECK_TYPES) files.set(`/${path}`, text);
  for (const [path, text] of Object.entries(declarations)) files.set(`/node_modules/myco/${path}`, text);
  files.set("/node_modules/myco/package.json", JSON.stringify({ name: "myco", types: "index.d.ts" }));
  const taken = (path: string) => path in project;
  const components = new Map<string, Awaited<ReturnType<typeof componentTypeScript>>>();
  for (const [path, text] of Object.entries(project)) {
    if (!path.endsWith(".svelte")) {
      files.set(`/project/${path}`, text);
      continue;
    }
    const component = await componentTypeScript(path, text, generatedPathOf(path, taken));
    components.set(`/project/${component.generated}`, component);
    files.set(`/project/${component.generated}`, component.code);
  }
  const options = { ...compilerOptions(SCRIPT_CHECK), noEmit: true } as ts.CompilerOptions;
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  Object.assign(host, {
    fileExists: (f: string) => files.has(f) || fileExists(f),
    readFile: (f: string) => files.get(f) ?? readFile(f),
    getSourceFile: (f: string, v: ts.ScriptTarget) => (files.has(f) ? ts.createSourceFile(f, files.get(f)!, v) : getSourceFile(f, v)),
    directoryExists: (d: string) => [...files.keys()].some((f) => f.startsWith(`${d}/`)) || ts.sys.directoryExists(d),
    getCurrentDirectory: () => "/project",
  });
  const roots = [...files.keys()].filter((f) => !f.endsWith(".json"));
  const program = ts.createProgram({ rootNames: roots, options, host });
  const out: Found[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const file = d.file?.fileName ?? "";
    if (!file.startsWith("/project/")) continue; // the service is asked about project files only
    const component = components.get(file);
    if (!component) {
      out.push({ path: file.replace(/^\/project\//, ""), message });
      continue;
    }
    if (!component.checked) continue;
    const range = component.sourceRange(d.start ?? 0, d.length ?? 0);
    if (range) out.push({ path: component.path, message, ...range });
  }
  for (const c of components.values()) if (c.error) out.push({ path: c.path, ...c.error });
  return out;
}

// Each check builds a TypeScript program with the engine's declarations and the DOM library: seconds, more under a full run.
describe("type checking inside Svelte components (ADR 0432)", { timeout: 60_000 }, () => {
  it("finds errors in the script and the template, at their places in the component", async () => {
    const found = await check({
      "ui/Hud.svelte": `<script lang="ts">
  import { Time } from "myco";
  import Badge from "./Badge.svelte";
  import { score } from "./score.svelte";
  let { label = "" }: { label?: string } = $props();
  let count = $state(0);
  const wrong: number = label;
  const step = Time.deltaTim;
</script>

<span text={label} onclick={(e) => e.clientXX}>{count.toFixed(1)}</span>
<Badge title={3} />
<p>{score.value.toUpperCase()}</p>
<p>{missing}</p>
`,
      "ui/Badge.svelte": `<script lang="ts">
  let { title }: { title: string } = $props();
</script>
<span text={title}></span>
`,
      "ui/score.svelte.ts": "export const score = $state({ value: 0 });\n",
    });
    const at = (f: Found) => `${f.path}:${f.line}:${f.column}-${f.endLine}:${f.endColumn}`;
    expect(found.map((f) => [at(f), f.message])).toEqual([
      ["ui/Hud.svelte:7:9-7:14", "Type 'string' is not assignable to type 'number'."],
      ["ui/Hud.svelte:8:21-8:29", "Property 'deltaTim' does not exist on type 'typeof Time'. Did you mean 'deltaTime'?"],
      ["ui/Hud.svelte:11:38-11:46", expect.stringMatching(/^Property 'clientXX' does not exist on type 'MouseEvent & /)],
      ["ui/Hud.svelte:12:8-12:14", "Type 'number' is not assignable to type 'string'."],
      ["ui/Hud.svelte:13:17-13:28", "Property 'toUpperCase' does not exist on type 'number'."],
      ["ui/Hud.svelte:14:5-14:12", "Cannot find name 'missing'."],
    ]);
  });

  it("types a component for the scripts and rune modules importing it, and accepts engine attributes", async () => {
    const found = await check({
      "ui/Badge.svelte": `<script lang="ts">
  let { title, onpick }: { title: string; onpick?: (id: number) => void } = $props();
</script>
<button text={title} interactable={true} nav-up="play" max-length={4} onclick={() => onpick?.(1)}></button>
`,
      "scripts/Use.ts": `import { mount } from "svelte";
import Badge from "../ui/Badge.svelte";
export const props: import("svelte").ComponentProps<typeof Badge> = { title: 2 };
`,
    });
    expect(found).toEqual([{ path: "scripts/Use.ts", message: "Type 'number' is not assignable to type 'string'." }]);
  });

  it("leaves JavaScript components unchecked, and reports syntax errors, still checking what can be read", async () => {
    const found = await check({
      "ui/Plain.svelte": "<script>\n  let n = 1;\n  n.nope();\n</script>\n<p>{n}</p>\n",
      "ui/Open.svelte": '<script lang="ts">\n  let a = 1;\n</script>\n<p>{a.nope}\n',
      "ui/Broken.svelte": '<script lang="ts">let a = 1;</script>\n<p {a></p>\n',
    });
    expect(found.map((f) => [`${f.path}:${f.line}:${f.column}`, f.message])).toEqual([
      ["ui/Open.svelte:4:7", "Property 'nope' does not exist on type 'number'."],
      ["ui/Open.svelte:4:1", "`<p>` was left open"],
      ["ui/Broken.svelte:2:6", "Expected token }"],
    ]);
  });

  it("puts a component's TypeScript where an import of it resolves, beside a rune module of that name", () => {
    expect(generatedPathOf("ui/Hud.svelte")).toBe("ui/Hud.svelte.ts");
    expect(generatedPathOf("ui/Hud.svelte", (p) => p === "ui/Hud.svelte.ts")).toBe("ui/Hud.svelte.tsx");
  });

  it("checks the samples' and the engine's built-in components without errors", async () => {
    const paths = [
      "samples/arena/ui/Hud.svelte",
      "samples/arena/ui/Menu.svelte",
      "samples/flappy/ui/Hud.svelte",
      "samples/navigation/ui/Hud.svelte",
      "samples/pirates/ui/Hud.svelte",
      "samples/pirates/ui/Menu.svelte",
      "samples/sound-lab/ui/Events.svelte",
      "samples/sound-lab/ui/Main.svelte",
      "samples/sound-lab/ui/Mixer.svelte",
      "samples/sound-lab/ui/Music.svelte",
      "samples/sound-lab/ui/Rhythm.svelte",
      "samples/sound-lab/ui/Spatial.svelte",
      "src/plugins/ui/builtin/ControlMapper.svelte",
      "src/plugins/subtitles/runtime/SubtitleRows.svelte",
    ];
    const project = Object.fromEntries(paths.map((p) => [p, readFileSync(p, "utf8")]));
    expect(await check(project)).toEqual([]);
  });
});
