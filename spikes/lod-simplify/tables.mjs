// Markdown tables generated from results.json (used by make-readme.mjs; run directly to print them all).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const load = () => JSON.parse(readFileSync(path.join(here, 'results.json'), 'utf8'));

const md = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const g = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '-' : (Math.abs(x) < 1e-4 && x !== 0 ? x.toExponential(1) : +(+x).toPrecision(d)).toString());
const hh = (x) => (x >= 1 ? '>= 1 (always)' : g(x, 3));
const pct = (x) => (x === null || x === undefined ? '-' : (x * 100).toFixed(2) + '%');
const ms = (t) => `${t.p50.toFixed(1)} / ${t.p99.toFixed(1)} / ${t.max.toFixed(1)}`;

export const tables = {
  inputs: (R) => md(['model', 'tris', 'raw verts', 'welded verts', 'position-welded verts', 'groups', 'open edges', 'bbox diag', 'skinned'],
    R.quality.inputs.map((r) => [r.model, r.tris, r.rawVerts, r.weldedVerts, r.positionWeldedVerts, r.groups, r.openEdges, g(r.bboxDiag), r.skinned ? 'yes' : ''])),
  distribution: (R) => {
    const d = R.distribution;
    return md(['module (npm meshoptimizer ' + d.npm.version + ', ' + d.npm.license + ')', 'file bytes', 'minified', 'minified + gzip -9', 'decoded wasm'],
      [...d.modules.map((m) => [m.file, m.raw, m.minified, m.minGzip, m.wasmDecoded]), ['simplifier + encoder bundled', '', d.combined.minified, d.combined.minGzip, '']]);
  },
  speed: (R, which) => {
    const sp = R.speed[which]; if (!sp || sp.error) return '(not run)';
    return md(['model', 'LOD0 tris', 'chain x3 attr (ms)', 'chain x3 pos (ms)', 'sloppy 5%+2% (ms)', 'cache+fetch opt, 4 levels (ms)', 'whole pipeline incl. weld (ms)', 'kTri/s (attr chain)'],
      sp.rows.map((r) => [r.name, r.tris, ms(r.timings.chainAttr), ms(r.timings.chainPos), ms(r.timings.sloppy), ms(r.timings.optimize), ms(r.timings.total), (r.timings.chainAttr.trisPerSec / 1000).toFixed(0)]));
  },
  speedExtra: (R) => {
    const n = R.speed.node, c = R.speed.chromium; if (!n || !c || c.error) return '(not run)';
    return md(['model', 'weld p50 node/chromium (ms)', 'attr+skin weights chain p50 node/chromium (ms)', 'Chromium / Node, whole pipeline p50'],
      n.rows.map((r, i) => { const rc = c.rows[i]; return [r.name, `${r.timings.weld.p50.toFixed(1)} / ${rc.timings.weld.p50.toFixed(1)}`, r.timings.chainAttrSkin ? `${r.timings.chainAttrSkin.p50.toFixed(1)} / ${rc.timings.chainAttrSkin.p50.toFixed(1)}` : '', (rc.timings.total.p50 / r.timings.total.p50).toFixed(2)]; }));
  },
  levels: (R, mode) => md(['model', 'level', 'target tris', 'achieved', 'meshopt err (step / cumulative, of max extent)', 'Hausdorff max (S->O / O->S)', 'Hausdorff mean (S->O / O->S)', 'normal dev mean / p95 (deg)', 'UV dev mean (of 0..1)', 'new open edges'],
    R.quality.q1.filter((r) => r.mode === mode).map((r) => [r.model, r.level, r.targetTris, `${r.tris} (${(r.reached * 100).toFixed(0)}%)`, `${pct(r.meshoptErrStep)} / ${pct(r.meshoptErrCum)} (${pct(r.meshoptErrCumDiag)} of diag)`, `${pct(r.fwdMax)} / ${pct(r.revMax)}`, `${pct(r.fwdMean)} / ${pct(r.revMean)}`, r.nAngMean === undefined ? '-' : `${g(r.nAngMean, 3)} / ${g(r.nAngP95, 3)}`, g(r.uvMean, 2), r.openDelta])),
  chainVsDirect: (R) => md(['model', 'build', 'tris at 12.5%', 'Hausdorff max', 'Hausdorff mean'], R.quality.q1b.map((r) => [r.model, r.build, r.tris, pct(r.max), pct(r.mean)])),
  errorLimit: (R) => {
    const rows = R.quality.q2; const models = [...new Set(rows.map((r) => r.model))]; const lims = [...new Set(rows.map((r) => r.errorLimit))];
    return md(['model (target tris at 12.5%)', ...lims.map((l) => (l >= 1 ? 'no limit' : `limit ${l * 100}%`))],
      models.map((m) => { const rs = rows.filter((r) => r.model === m); return [`${m} (${rs[0].targetTris})`, ...lims.map((l) => { const r = rs.find((x) => x.errorLimit === l); return `${r.tris} (${(r.reached * 100).toFixed(0)}%)`; })]; }));
  },
  flags: (R) => md(['model', 'mode', 'flags', 'tris (target)', 'meshopt err', 'Hausdorff max', 'new open edges', 'border edges after/before'],
    R.quality.q3.map((r) => [r.model, r.mode, r.flags, `${r.tris} (${r.targetTris})`, pct(r.meshoptErr), pct(r.max), r.openDelta, r.borderEdges0 !== undefined ? `${r.borderEdges} / ${r.borderEdges0}` : ''])),
  submesh: (R) => md(['model', 'strategy', 'shared verts', 'tris (target)', 'per-group ratio min..max', 'Hausdorff max', 'new open edges (cracks)'],
    R.quality.q4.map((r) => [r.model, r.strategy, r.sharedVertices, `${r.tris} (${r.targetTris})`, r.groupRatioMin === null ? 'n/a (materials lost)' : `${g(r.groupRatioMin, 2)}..${g(r.groupRatioMax, 2)}`, pct(r.max), r.openDelta])),
  seams: (R) => md(['model', 'input variant', 'verts', 'tris in', 'tris out (target = 12.5%)', 'Hausdorff max', 'normal dev mean (deg)', 'UV dev mean / p95', 'open-edge change'],
    R.quality.q5.map((r) => [r.model, r.variant, r.verts, r.inTris, `${r.tris} (${Math.round(r.inTris * 0.125)})`, pct(r.haus), r.nAngMean === undefined ? '' : g(r.nAngMean, 3), r.uvMean === undefined ? '' : `${g(r.uvMean, 2)} / ${g(r.uvP95, 2)}`, r.openDelta])),
  config: (R) => md(['model', 'build', 'level (ratio, limit of max extent)', 'tris (target)', 'limit as % of bbox diag', 'Hausdorff max', 'max / limit', 'Hausdorff mean', 'time for 3 levels (ms, single run)'],
    R.quality.q9.map((r) => [r.model, r.build, `${r.level} (${r.ratio * 100}%, ${r.errorLimit * 100}%)`, `${r.tris} (${r.targetTris})`, pct(r.limitOfDiag), pct(r.max), g(r.max / r.limitOfDiag, 2), pct(r.mean), r.level === 1 ? g(r.ms, 3) : ''])),
  sizes: (R) => md(['model', 'tris', 'verts', 'LOD0 only (KiB)', 'separate VB+IB per level', 'shared VB (LOD0 order) + IB per level', 'ratio separate / shared (32 B vtx)', 'ratio separate / shared (16 B quantised vtx)'],
    R.quality.q6.map((r) => [r.model, r.tris0, r.verts0, (r.lod0Bytes / 1024).toFixed(0), `${(r.separateBytes / 1024).toFixed(0)} KiB (x${g(r.separateOverLod0, 3)})`, `${(r.sharedBytes / 1024).toFixed(0)} KiB (x${g(r.sharedOverLod0, 3)})`, `${g(r.separateOverLod0, 3)} / ${g(r.sharedOverLod0, 3)}`, `${g(r.separateOverLod0Quant, 3)} / ${g(r.sharedOverLod0Quant, 3)}`])),
  locality: (R) => {
    const rows = [];
    for (const r of R.quality.q6) { const L = r.levels[3]; const L1 = r.levels[1]; rows.push([r.model, `${L.usedVerts}`, `${L.missOwn}`, `${L.missShared} (x${(L.missShared / L.missOwn).toFixed(2)})`, `${L.missPrefix} (x${(L.missPrefix / L.missOwn).toFixed(2)})`, `${L.lines64Shared} / ${L.lines64Prefix} / ${L.minLines64}`, `${L.acmrBefore} -> ${L.acmrOwn}`, `${r.levels[0].missOwn} vs ${r.levels[0].missPrefix}`, `${L1.missOwn} / ${L1.missShared} / ${L1.missPrefix}`]); }
    return md(['model', 'verts used by LOD3', 'LOD3 LRU line misses, own VB', 'shared VB, LOD0 order', 'shared VB, coarsest-first order', 'LOD3 distinct 64 B lines: shared / coarsest-first / minimum', 'ACMR before -> after (LOD3)', 'LOD0 misses: own vs coarsest-first VB', 'LOD1 misses own / shared / coarsest-first'], rows);
  },
  skin: (R) => md(['model', 'ratio', 'variant', 'tris', 'bad joint idx', 'weight sums != 1', 'bind-pose Hausdorff max / mean', 'posed (3 random poses) Hausdorff max / mean'],
    R.quality.q7.map((r) => [r.model, r.ratio, r.variant, r.tris, r.badJointIndices, r.badWeightSums, `${pct(r.bindMax)} / ${pct(r.bindMean)}`, `${pct(r.posedMaxMean)} / ${pct(r.posedMeanMean)}`])),
  screen: (R) => md(['error (fraction of mesh size D)', 'px of error when object fills the viewport height (1080p)', 'LOD can be used below screen height (1 px tolerance)', '... (2 px tolerance)'],
    R.quality.screen.map((r) => [pct(r.errorFrac), g(r.px_at_full_height, 3), hh(r.h1px), hh(r.h2px)])),
  transitions: (R) => md(['model', 'LOD1 (50%)', 'LOD2 (25%)', 'LOD3 (12.5%)'],
    [...new Set(R.quality.transitions.map((r) => r.model))].map((m) => [m, ...[1, 2, 3].map((l) => { const r = R.quality.transitions.find((x) => x.model === m && x.level === l); return `err ${pct(r.hausMax)} -> ${r.h1px >= 1 ? '1' : g(r.h1px, 2)} / ${r.h2px >= 1 ? '1' : g(r.h2px, 2)}`; })])),
  sloppy: (R) => md(['model', 'target', 'tris (target)', 'meshopt err', 'Hausdorff max (S->O / O->S)', 'Hausdorff mean', 'normal dev mean (deg)', 'UV dev mean'],
    R.quality.q1.filter((r) => r.mode === 'sloppy').map((r) => [r.model, pct(r.ratio), `${r.tris} (${r.targetTris})`, pct(r.meshoptErrStep), `${pct(r.fwdMax)} / ${pct(r.revMax)}`, pct(r.mean), r.nAngMean === undefined ? '-' : g(r.nAngMean, 3), g(r.uvMean, 2)])),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const R = load();
  for (const [k, f] of Object.entries(tables)) { console.log(`\n### ${k}\n`); console.log(k === 'speed' ? f(R, 'node') : k === 'levels' ? f(R, 'attr') : f(R)); }
}
