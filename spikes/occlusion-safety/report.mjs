// Aggregates out/results-raw.json (+ meta.json) into results.json and tables.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
const raw = JSON.parse(readFileSync(join(outDir, process.argv[2] || 'results-raw.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
const TYPES = meta.types;
const RES = raw.res.map(([w, h]) => `${w}x${h}`);

// aggregate rows by key function
function agg(rows) {
  const a = { inFrustum: 0, oracleHidden: 0, culled: 0, falseOcc: 0, ge16: 0, framesFalse: 0, frames: 0, tris: 0, distinct: 0, pxMin: Infinity };
  for (const r of rows) {
    a.inFrustum += r.inFrustum; a.oracleHidden += r.oracleHidden; a.culled += r.culled; a.falseOcc += r.falseOcc; a.ge16 += r.falseGe16; a.framesFalse += r.framesFalse;
    a.frames += r.frames; a.tris += r.tris; a.distinct += r.distinctFalse; if (r.falseOcc) a.pxMin = Math.min(a.pxMin, r.falsePxMin);
  }
  a.correct = a.culled - a.falseOcc;
  a.keptPct = a.oracleHidden ? (100 * a.correct) / a.oracleHidden : 0;
  return a;
}
const by = (rows, f) => { const m = new Map(); for (const r of rows) { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const sceneName = (i) => meta.scenes[i].name;
const pathName = (s, p) => meta.scenes[s].paths[p];

const summary = []; // per type, res, rule
for (let t = 0; t < TYPES.length; t++) for (let r = 0; r < RES.length; r++) for (let u = 0; u < raw.rules.length; u++) {
  const rows = raw.rows.filter((x) => x.type === t && x.res === r && x.rule === u);
  const a = agg(rows);
  const perScene = {};
  for (const [s, rs] of by(rows, (x) => x.scene)) { const q = agg(rs); perScene[sceneName(s)] = { falseOcc: q.falseOcc, falseGe16: q.ge16, culled: q.culled, oracleHidden: q.oracleHidden, framesFalse: q.framesFalse }; }
  const perPath = []; const allPaths = [];
  for (const [k, rs] of by(rows, (x) => `${x.scene}/${x.path}`)) { const q = agg(rs); { const [s2, p2] = k.split('/').map(Number); allPaths.push({ path: `${sceneName(s2)}/${pathName(s2, p2)}`, oracleHidden: q.oracleHidden, correct: q.correct, falseOcc: q.falseOcc, falseGe16: q.ge16 }); } if (q.falseOcc) { const [s, p] = k.split('/').map(Number); perPath.push({ path: `${sceneName(s)}/${pathName(s, p)}`, falseOcc: q.falseOcc, falseGe16: q.ge16, framesFalse: q.framesFalse, distinct: q.distinct }); } }
  summary.push({ type: TYPES[t], res: RES[r], rule: raw.rules[u], inFrustum: a.inFrustum, oracleHidden: a.oracleHidden, culled: a.culled, correct: a.correct, keptPct: a.keptPct, falseOcc: a.falseOcc, falseGe16: a.ge16, framesFalse: a.framesFalse, frames: a.frames, falsePxMin: Number.isFinite(a.pxMin) ? a.pxMin : null, tris: a.tris, perScene, perPath, allPaths });
}
const frameCount = summary[0].frames;
const results = { generated: 'run.mjs', frameSamples: frameCount, rules: raw.rules, meta, summary };
writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 1));

// ---- tables
const pct = (x) => x.toFixed(1);
let md = '';
const line = (...c) => { md += `| ${c.join(' | ')} |\n`; };
for (const res of RES) {
  md += `\n### Rule sets x stand-in type, ${res} (false occlusions, and in brackets those with >= 16 visible px at 1080p / correct culls kept as % of the oracle's culls)\n\n`;
  line('rule set', ...TYPES.map((t) => t)); line('---', ...TYPES.map(() => '---'));
  raw.rules.forEach((name) => {
    const cells = TYPES.map((t) => { const s = summary.find((x) => x.type === t && x.res === res && x.rule === name); return `**${s.falseOcc}**${s.falseOcc ? ` (${s.falseGe16})` : ''} / ${pct(s.keptPct)}%`; });
    line(name, ...cells);
  });
  const o = summary.find((x) => x.type === 'orig' && x.res === res && x.rule === raw.rules[0]);
  md += `\n(in-frustum occludee-frames ${o.inFrustum}; oracle-hidden ${o.oracleHidden}; frames ${o.frames} per cell)\n`;
}

// ---- stand-in table
md += `\n### Stand-ins: size, sampled two-way Hausdorff error (fraction of bbox diagonal) and import cost\n\n`;
line('occluder', 'tris', 'type', 'stand-in tris', 'error (15k samples)', 'error (100k samples)', 'Hausdorff ms', 'per-tri error pass ms'); line(...Array(8).fill('---'));
for (const o of meta.occluders) for (const k of TYPES.slice(1)) { const t = o.types[k]; line(`${o.scene}/${o.name}${o.exempt ? ' (<=512: exempt)' : ''}`, o.tris, k, t.tris, (100 * t.errFrac).toFixed(2) + '%', (100 * t.denseFrac).toFixed(2) + '%', t.hausMs.toFixed(0), t.triErrMs.toFixed(0)); }
// ---- per scene, selected rules
const sel = ['none', 'FULL b+c+d2x+e', 'FULL, d=3 m', 'FULL + trim 0.5%', 'PROPOSED, errors x2'];
for (const t of ['simp5', 'sloppy5']) {
  md += `\n### Per scene, ${t}, 256x128: false occlusions (>=16 px) / correct culls kept % of the oracle's culls\n\n`;
  const sc = meta.scenes.map((s) => s.name);
  line('rule set', ...sc); line('---', ...sc.map(() => '---'));
  for (const rn of sel) { const s = summary.find((x) => x.type === t && x.res === '256x128' && x.rule === rn); line(rn, ...sc.map((n) => { const p = s.perScene[n]; return `${p.falseOcc} (${p.falseGe16}) / ${p.oracleHidden ? (100 * (p.culled - p.falseOcc) / p.oracleHidden).toFixed(1) : '-'}%`; })); }
}
for (const t of ['simp5', 'sloppy5']) {
  const selp = ['none', 'FULL b+c+d2x+e', 'FULL + trim 0.5%', 'PROPOSED, errors x2'];
  md += `\n### Per camera path, ${t}, 256x128: false occlusions (>=16 px) / correct culls kept % of the oracle's culls\n\n`;
  line('path', 'oracle culls', ...selp); line('---', '---', ...selp.map(() => '---'));
  const base = summary.find((x) => x.type === t && x.res === '256x128' && x.rule === selp[0]).allPaths;
  base.forEach((bp, i) => line(bp.path, bp.oracleHidden, ...selp.map((rn) => { const p = summary.find((x) => x.type === t && x.res === '256x128' && x.rule === rn).allPaths[i]; return `${p.falseOcc} (${p.falseGe16}) / ${p.oracleHidden ? (100 * p.correct / p.oracleHidden).toFixed(0) : '-'}%`; })));
}
writeFileSync(join(here, 'tables.md'), md);
console.log(md);
