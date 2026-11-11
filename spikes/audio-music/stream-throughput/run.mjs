#!/usr/bin/env node
// The full timed set for the stream-throughput spike. Run it on an IDLE machine.
//   node run.mjs                 full set (about 55 minutes: see the table below)
//   node run.mjs --smoke         10-second smoke of every part (about 3 minutes), numbers are NOT for the record
//   node run.mjs --only q1,q4    a subset (q1 decode cost, q2 concurrency, q2clip, q3 chromium, q4 memory)
// Output: results/*.json and results/summary.md (all the tables, ready to paste into README.md), and the same on stdout.
//
// Part  what                                              runs  per run  about
// q1    decode cost per codec, Node, real decode wasm       5    3 passes  1 min
// q2    N = 4,8,16,24,32,48,64 mp3; 4,16,32,64 vorbis/flac  5    15 s      22 min (incl. 2 N with a clip decode)
// q3    Chromium, real worker + worklet, 5 configs + 2     5    60 s/15 s  29 min
// q4    memory (deterministic)                              -    -         < 1 min
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { here, flag, opt } from './common.mjs';

const smoke = flag('--smoke');
const only = opt('--only', 'q4,q1,q2,q2clip,q3').split(',');
const runs = smoke ? 1 : 5;
const steps = [
  ['build', ['build.mjs']],
  ['q4', ['q4_memory.mjs']],
  ['q1', ['q1_decode.mjs', '--runs', runs, '--passes', smoke ? 1 : 3]],
  ['q2', ['q2_concurrency.mjs', '--runs', runs, ...(smoke ? ['--seconds', 8, '--ns', '4,16,32', '--ns2', '16'] : [])]],
  ['q2clip', ['q2_concurrency.mjs', '--runs', runs, '--clip', '--codecs', 'mp3-cbr192', '--ns', '8,16', ...(smoke ? ['--seconds', 8] : [])]],
  ['q3', ['q3_chromium.mjs', '--runs', runs, '--seconds', smoke ? 10 : 60, ...(smoke ? ['--configs', 'high:16:mp3-cbr192,low:8:mp3-cbr192:6'] : [])]],
  ['q3control', ['q3_chromium.mjs', '--runs', 1, '--seconds', 8, '--control', '--configs', 'default:8:mp3-cbr192', '--tag', 'control']],
];
mkdirSync(join(here, 'results'), { recursive: true });
let summary = `# Stream-throughput spike: runner output\n\nDate: ${new Date().toISOString()}${smoke ? ' (SMOKE, not for the record)' : ''}. Host: ${spawnSync('uname', ['-srm']).stdout.toString().trim()}, ${spawnSync('nproc').stdout.toString().trim()} vCPUs, load before start: ${spawnSync('cat', ['/proc/loadavg']).stdout.toString().trim()}\n\n`;
for (const [name, a] of steps) {
  if (name !== 'build' && !only.includes(name === 'q3control' ? 'q3' : name)) continue;
  console.error(`\n=== ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync('node', a.map(String), { cwd: here, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  const text = r.stdout.toString();
  console.log(text);
  summary += `## ${name} (${((Date.now() - t0) / 1000).toFixed(0)} s)${r.status ? ' FAILED' : ''}\n\n${text}\n`;
  if (r.status) { console.error(`${name} failed`); if (name === 'build') process.exit(1); }
}
writeFileSync(join(here, 'results', smoke ? 'summary-smoke.md' : 'summary.md'), summary);
