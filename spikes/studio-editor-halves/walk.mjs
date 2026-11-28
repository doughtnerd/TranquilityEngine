// Import walker: static closure (and static+dynamic) of each editor half, with risk flags.
// Run from the repo root: node spikes/studio-editor-halves/walk.mjs
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const EXTS = [".ts", ".tsx", ".svelte.ts", ".svelte", ".js", ".mjs", ".css"];
function resolve(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, "index" + e)), base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")];
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}
const cache = new Map();
function edges(file) {
  if (cache.has(file)) return cache.get(file);
  const r = { stat: [], dyn: [], ext: [] };
  cache.set(file, r);
  if (!/\.(tsx?|mjs|js)$/.test(file)) return r;
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (spec, kind) => {
    const t = resolve(file, spec);
    if (t) r[kind].push(t);
    else if (!spec.startsWith(".")) r.ext.push(spec);
    else if (/\.(svelte|css)$/.test(spec)) r[kind].push(path.resolve(path.dirname(file), spec));
  };
  (function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && !(ts.isImportDeclaration(n) && n.importClause?.isTypeOnly) && !(ts.isExportDeclaration(n) && n.isTypeOnly)) {
      const ic = ts.isImportDeclaration(n) ? n.importClause : null;
      const allType = ic && !ic.name && ic.namedBindings && ts.isNamedImports(ic.namedBindings) && ic.namedBindings.elements.length > 0 && ic.namedBindings.elements.every((e) => e.isTypeOnly);
      if (!allType) add(n.moduleSpecifier.text, "stat");
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(n.arguments[0])) add(n.arguments[0].text, "dyn");
    ts.forEachChild(n, visit);
  })(sf);
  return r;
}
export function closure(entry, withDynamic) {
  const seen = new Set(), ext = new Set(), parent = new Map(), q = [path.resolve(entry)];
  while (q.length) {
    const f = q.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(f)) continue;
    const e = edges(f);
    e.ext.forEach((x) => ext.add(x));
    for (const t of [...e.stat, ...(withDynamic ? e.dyn : [])]) if (!seen.has(t) && !parent.has(t)) { parent.set(t, f); q.push(t); }
  }
  return { files: seen, ext, parent };
}
const bytes = (s) => [...s].reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
const rel = (f) => path.relative(root, f);
const FLAGS = {
  "editor/state.ts": (f) => rel(f) === "src/editor/state.ts",
  "layout/store": (f) => /src\/editor\/layout\/store/.test(rel(f)),
  "editor shell UI (ui|panels|views|shell)": (f) => /^src\/editor\/(ui|panels|views|shell)\//.test(rel(f)),
  css: (f) => f.endsWith(".css"),
  svelte: (f) => f.endsWith(".svelte"),
};
const EXTFLAGS = { monaco: /monaco/, babylon: /^@babylonjs/, three: /^three/, react: /^react/, rapier: /rapier/, howler: /howler/, svelte: /^svelte/ };
const entries = fs.readdirSync("src/plugins").map((d) => `src/plugins/${d}/editor/index.ts`).filter((p) => fs.existsSync(p));
const studioBase = closure("src/studio/main.tsx", false);
const sdk = closure("src/editor/sdk/index.ts", false);
console.log(`studio main.tsx static closure: ${studioBase.files.size} modules, ${(bytes(studioBase.files) / 1024) | 0} KiB`);
console.log(`editor/sdk/index.ts static closure: ${sdk.files.size} modules, ${(bytes(sdk.files) / 1024) | 0} KiB; editor/state.ts in it: ${sdk.files.has(path.resolve("src/editor/state.ts"))}`);
console.log("\nhalf | static mods | KiB | new vs Studio (mods/KiB) | +dynamic mods | flags (static / dyn) | ext pkgs (static)");
const allNew = new Set(), allNewDyn = new Set();
for (const e of entries) {
  const name = e.split("/")[2];
  const s = closure(e, false), d = closure(e, true);
  const flags = Object.entries(FLAGS).filter(([, fn]) => [...s.files].some(fn)).map(([k]) => k);
  const ef = Object.entries(EXTFLAGS).filter(([, re]) => [...s.ext].some((x) => re.test(x))).map(([k]) => k);
  const dflags = Object.entries(FLAGS).filter(([, fn]) => [...d.files].some(fn) && ![...s.files].some(fn)).map(([k]) => k + "(dyn)");
  const newF = [...s.files].filter((f) => !studioBase.files.has(f));
  newF.forEach((f) => allNew.add(f));
  [...d.files].filter((f) => !studioBase.files.has(f)).forEach((f) => allNewDyn.add(f));
  console.log(`${name} | ${s.files.size} | ${(bytes(s.files) / 1024) | 0} | ${newF.length}/${(bytes(new Set(newF)) / 1024) | 0} | ${d.files.size} | ${[...flags, ...dflags].join(",") || "-"} | ${ef.join(",") || "-"}`);
  const st = path.resolve("src/editor/state.ts");
  if (s.files.has(st)) {
    const chain = [st]; let c = st; while (s.parent.has(c)) { c = s.parent.get(c); chain.push(c); }
    console.log(`   state.ts chain: ${chain.reverse().map(rel).join(" -> ")}`);
  }
}
console.log(`\nUNION of all halves: new static modules vs studio main: ${allNew.size} (${(bytes(allNew) / 1024) | 0} KiB); incl. dynamic: ${allNewDyn.size} (${(bytes(allNewDyn) / 1024) | 0} KiB)`);
const u = new Set();
entries.forEach((e) => closure(e, false).files.forEach((f) => u.add(f)));
console.log(`union static closure of all halves alone: ${u.size} modules, ${(bytes(u) / 1024) | 0} KiB`);
