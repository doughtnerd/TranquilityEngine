// Q2: min+gzip sizes. Bundles with esbuild (the repo's, tree-shaken, minified, browser target) and gzips
// at level 9. Run: node sizes.mjs   (writes out/sizes.json and prints a table)
import { build } from "../../node_modules/esbuild/lib/main.js";
import { compile } from "svelte/compiler";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const out = join(here, "out/sizes");
mkdirSync(out, { recursive: true });

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const br = (buf) => brotliCompressSync(buf).length;
const kb = (n) => (n / 1024).toFixed(1);

// A renderer with no engine behind it, so the bundle holds only Svelte's runtime and the components.
writeFileSync(join(out, "stub-renderer.js"), `import { createRenderer } from "svelte/renderer";
const n = () => ({ c: [], p: null });
export default createRenderer({ createFragment: n, createElement: n, createText: n, createComment: n,
  getNodeType: () => "element", getText: () => "", setText() {}, getAttribute: () => null, setAttribute() {},
  removeAttribute() {}, hasAttribute: () => false, getFirstChild: () => null, getLastChild: () => null,
  getNextSibling: () => null, getParent: () => null, insert() {}, remove() {}, addEventListener() {}, removeEventListener() {} });
`);

const COMPONENTS = ["Hud", "Shop", "Price", "Card"];
const HELLO = `<script>let n = $state(0);</script><button onclick={() => n++}>{n}</button>`;

function compileAll(customRenderer) {
  const dir = join(out, customRenderer ? "cr" : "dom");
  mkdirSync(dir, { recursive: true });
  const opts = (f) => ({ filename: f, generate: "client", css: "external", dev: false, runes: true, ...(customRenderer ? { experimental: { customRenderer: join(out, "stub-renderer.js") } } : {}) });
  for (const c of COMPONENTS) {
    const src = readFileSync(join(here, "src/components", `${c}.svelte`), "utf8");
    writeFileSync(join(dir, `${c}.svelte.js`), compile(src, opts(`${c}.svelte`)).js.code.replaceAll(".svelte\"", ".svelte.js\"").replaceAll(".svelte'", ".svelte.js'"));
  }
  writeFileSync(join(dir, "Hello.svelte.js"), compile(HELLO, opts("Hello.svelte")).js.code);
  return dir;
}

async function bundle(name, contents, resolveDir, conditions, extra = {}) {
  const r = await build({
    stdin: { contents, resolveDir, sourcefile: `${name}.js` },
    bundle: true, write: false, minify: true, treeShaking: true, format: "esm", platform: "browser",
    target: "es2022", conditions, metafile: true, logLevel: "silent", nodePaths: [join(here, "node_modules")], ...extra,
  });
  const code = r.outputFiles[0].contents;
  writeFileSync(join(out, `${name}.min.js`), code);
  const inputs = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]].inputs;
  const byPkg = {};
  for (const [file, { bytesInOutput }] of Object.entries(inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
    const key = m ? m[1] : /(^|\/)src\/engine\//.test(file) ? "(engine)" : "(components+glue)";
    byPkg[key] = (byPkg[key] ?? 0) + bytesInOutput;
  }
  return { name, min: code.length, gzip: gz(code), brotli: br(code), minByPackage: byPkg };
}

const results = [];
const CR = ["svelte-custom-renderer", "browser", "production", "import", "default"];
const DOM = ["browser", "production", "import", "default"];
const MOUNT = `import { mount, unmount, flushSync } from "svelte"; import r from "../stub-renderer.js";`;

{
  const cr = compileAll(true);
  results.push(await bundle("cr-hello", `${MOUNT} import C from "./Hello.svelte.js"; export const go = (t) => { const i = mount(C, { target: t, renderer: r }); flushSync(); return () => unmount(i); };`, cr, CR));
  results.push(await bundle("cr-sample", `${MOUNT} import Hud from "./Hud.svelte.js"; import Card from "./Card.svelte.js"; export const go = (t, p) => { const a = mount(Hud, { target: t, props: p, renderer: r }); const b = mount(Card, { target: t, props: p, renderer: r }); flushSync(); return () => { unmount(a); unmount(b); }; };`, cr, CR));
  // The runtime alone: the sample bundle with the components' own code subtracted is in minByPackage.
  const dom = compileAll(false);
  results.push(await bundle("dom-hello", `import { mount } from "svelte"; import C from "./Hello.svelte.js"; export const go = (t) => mount(C, { target: t });`, dom, DOM));
  results.push(await bundle("dom-sample", `import { mount } from "svelte"; import Hud from "./Hud.svelte.js"; import Card from "./Card.svelte.js"; export const go = (t, p) => { mount(Hud, { target: t, props: p }); mount(Card, { target: t, props: p }); };`, dom, DOM));
}

// The compiler, as the editor/export would ship it to compile .svelte in the browser (or a worker).
results.push(await bundle("svelte-compiler", `export { compile, compileModule, parse } from "svelte/compiler";`, here, ["browser", "production", "import", "default"]));
results.push(await bundle("svelte-compiler-parse-only", `export { parse } from "svelte/compiler";`, here, ["browser", "production", "import", "default"]));
{
  const pre = readFileSync(join(here, "node_modules/svelte/compiler/index.js"));
  results.push({ name: "svelte/compiler/index.js (prebuilt, as published)", min: pre.length, gzip: gz(pre), brotli: br(pre) });
}

// The UI document parsers chunk today (ADR 0077): parsers.ts + htmlparser2 + css-tree's parser; the
// engine modules it shares with the main bundle are left out, as in the real chunk split.
{
  const doc = join(repo, "src/engine/ui/document");
  const external = {
    name: "engine-external",
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (a) => {
        const p = join(a.resolveDir, a.path);
        if (a.importer.includes("node_modules")) return null; // a library's own files
        return p.startsWith(doc) ? null : { path: a.path, external: true };
      });
    },
  };
  results.push(await bundle("ui-document-parsers", `export * from ${JSON.stringify(join(doc, "parsers.ts"))};`, doc, ["browser", "production", "import", "default"], { plugins: [external], nodePaths: [join(repo, "node_modules")] }));
}

writeFileSync(join(here, "out/sizes.json"), JSON.stringify(results, null, 2));
console.log("| bundle | min KB | gzip KB | brotli KB |\n|---|---:|---:|---:|");
for (const r of results) console.log(`| ${r.name} | ${kb(r.min)} | ${kb(r.gzip)} | ${kb(r.brotli)} |`);
for (const r of results) if (r.minByPackage) console.log(r.name, Object.fromEntries(Object.entries(r.minByPackage).map(([k, v]) => [k, kb(v)])));
