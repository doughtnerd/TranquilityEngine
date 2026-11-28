// node analyze.mjs out/player-report.json  -> markdown tables on stdout
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const rows = JSON.parse(readFileSync(process.argv[2] ?? new URL("./out/player-report.json", import.meta.url), "utf8"));
const k = (n) => (n / 1024).toFixed(1);
const chunks = rows.filter((r) => !r.asset).sort((a, b) => b.raw - a.raw);
const short = (id) => id.replace(/^.*?\/node_modules\//, "nm/").replace(/^.*?TranquilityEngine\/(\.claude\/worktrees\/[^/]+\/)?/, "");
const topDirs = (r) => {
  const by = new Map();
  for (const m of r.modules) {
    const id = short(m.id);
    let key = id.startsWith("nm/") ? id.split("/").slice(0, id.split("/")[1].startsWith("@") ? 3 : 2).join("/") : id.split("/").slice(0, id.startsWith("src/plugins/") || id.startsWith("src/engine/") ? 3 : 2).join("/");
    by.set(key, (by.get(key) ?? 0) + m.rendered);
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `${n} ${k(v)}`).join("; ");
};
console.log(`## Chunks (${chunks.length}), total raw ${k(chunks.reduce((s, c) => s + c.raw, 0))} kB, gzip ${k(chunks.reduce((s, c) => s + c.gzip, 0))} kB`);
console.log("\n| chunk | kind | raw kB | gzip kB | brotli kB | top contents (rendered kB) |\n|---|---|---|---|---|---|");
for (const c of chunks) console.log(`| ${c.file.replace("assets/", "")} | ${c.entry ? "entry" : c.dynamic ? "lazy" : "shared"} | ${k(c.raw)} | ${k(c.gzip)} | ${k(c.brotli)} | ${topDirs(c)} |`);
for (const a of rows.filter((r) => r.asset)) console.log(`asset ${a.file}: raw ${k(a.raw)} gzip ${k(a.gzip)}`);

// Localisation per module, grouped by subfolder.
console.log("\n## src/engine/localisation by subfolder (rendered, pre-minify-per-module sizes as Rollup reports them)\n");
const loc = new Map(), where = new Map();
for (const c of chunks) for (const m of c.modules) {
  const id = short(m.id);
  if (!id.startsWith("src/engine/localisation/")) continue;
  const rel = id.slice("src/engine/localisation/".length);
  const group = rel.includes("/") ? rel.split("/")[0] + "/" : /^subtitle/.test(rel) ? "subtitles*.ts" : "root (" + rel + ")";
  const e = loc.get(group) ?? { rendered: 0, files: [] };
  e.rendered += m.rendered; e.files.push(`${rel} ${m.rendered} [${c.file.replace("assets/", "")}]`);
  loc.set(group, e);
}
for (const [g, e] of [...loc].sort()) console.log(`- ${g}: ${e.rendered} B across ${e.files.length} module(s)\n    ${e.files.join("\n    ")}`);
console.log("TOTAL rendered:", [...loc.values()].reduce((s, e) => s + e.rendered, 0));

// Which chunk holds each feature
const feature = { "debugLink": "src/engine/debugLink/", "capture": "src/plugins/audio/runtime/capture/", "localisation": "src/engine/localisation/", "uiCore": "src/engine/ui/", "svelte": "nm/svelte", "babylon": "nm/@babylonjs", "three": "nm/three", "rapier": "nm/@dimforge", "audioRuntime": "src/plugins/audio/" };
console.log("\n## Feature -> chunks (rendered kB per chunk)\n");
for (const [f, p] of Object.entries(feature)) {
  const parts = [];
  let total = 0;
  for (const c of chunks) { const s = c.modules.filter((m) => short(m.id).startsWith(p)).reduce((t, m) => t + m.rendered, 0); if (s) { parts.push(`${c.file.replace("assets/", "")} ${k(s)}`); total += s; } }
  console.log(`- ${f}: total ${k(total)} kB rendered; ${parts.join(", ")}`);
}
