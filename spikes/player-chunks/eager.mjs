// node eager.mjs [report.json]: eager (static-import closure of player entry + myco.js) vs lazy, and
// per-file localisation estimates (module rendered length scaled by its chunk's minified raw/gzip ratio).
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync(process.argv[2] ?? new URL("./out/player-report.json", import.meta.url), "utf8"));
const k = (n) => (n / 1024).toFixed(1);
const chunks = rows.filter((r) => !r.asset);
const short = (id) => id.replace(/^.*?\/node_modules\//, "nm/").replace(/^.*?TranquilityEngine\/(\.claude\/worktrees\/[^/]+\/)?/, "");
const byFile = new Map(chunks.map((c) => [c.file, c]));
const eager = new Set();
const walk = (f) => { if (eager.has(f) || !byFile.has(f)) return; eager.add(f); byFile.get(f).imports.forEach(walk); };
console.log("entries:", chunks.filter((c) => c.entry).map((c) => `${c.file} ${k(c.raw)}/${k(c.gzip)}`).join(", "));
for (const c of chunks) if (c.entry) walk(c.file);
const sum = (key) => [...eager].reduce((s, f) => s + byFile.get(f)[key], 0);
console.log(`\neager (all entries): ${eager.size} chunks, raw ${k(sum("raw"))} kB, gzip ${k(sum("gzip"))} kB, brotli ${k(sum("brotli"))} kB`);
const lazy = chunks.filter((c) => !eager.has(c.file));
console.log(`lazy-only: ${lazy.length} chunks, raw ${k(lazy.reduce((s, c) => s + c.raw, 0))} kB, gzip ${k(lazy.reduce((s, c) => s + c.gzip, 0))} kB`);
const est = new Map();
for (const c of chunks) {
  const tot = c.modules.reduce((s, m) => s + m.rendered, 0) || 1;
  for (const m of c.modules) {
    const id = short(m.id);
    if (id.startsWith("src/engine/localisation/")) est.set(id.slice(24), { raw: (m.rendered * c.raw) / tot, gz: (m.rendered * c.gzip) / tot, where: eager.has(c.file) ? "eager" : "lazy", chunk: c.file.replace("assets/", "") });
  }
}
console.log("\nlocalisation file\traw~\tgzip~\tchunk class\tchunk");
for (const [rel, e] of [...est].sort()) console.log(`${rel}\t${e.raw.toFixed(0)}\t${e.gz.toFixed(0)}\t${e.where}\t${e.chunk}`);
const T = [...est.values()];
console.log(`TOTAL\t${T.reduce((s, e) => s + e.raw, 0).toFixed(0)}\t${T.reduce((s, e) => s + e.gz, 0).toFixed(0)}`);
