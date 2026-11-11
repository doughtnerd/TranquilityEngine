#!/usr/bin/env node
// Q3: the real decoder worker (build/decoder.worker.js = decoder.worker.ts bundled, unchanged) feeding the real AudioWorklet
// processor (build/processor.js = processor.ts + CoreDriver + myco_audio.wasm) in Chromium, N stream voices, counting the
// core's starvation reports (STATUS `starved` + stream event 1) and the shell's underrun probe. The AudioContext is a
// REAL-TIME AudioContext (the worker/worklet race only exists in real time), rendering to Chromium's null/fake sink; the
// container has no audio device. --offline runs an OfflineAudioContext instead (faster than real time, correctness smoke only).
// node q3_chromium.mjs [--runs 5] [--seconds 60] [--configs low:4:mp3-cbr192,default:8:mp3-cbr192,high:16:mp3-cbr192,high:16:vorbis-q5,high:16:flac]
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium } from '/home/user/TranquilityEngine/node_modules/playwright-core/index.mjs';
import { here, opt, flag, median, f, saveJson, CORE_WASM, DEC_WASM } from './common.mjs';
import { ensureFixtures } from './fixtures.mjs';

const runs = +opt('--runs', 5);
const seconds = +opt('--seconds', 60);
const offline = flag('--offline');
const MIXED = { low: 64, default: 128, high: 256 };
const control = flag('--control');
const configs = opt('--configs', 'low:4:mp3-cbr192,default:8:mp3-cbr192,high:16:mp3-cbr192,high:16:vorbis-q5,high:16:flac,low:8:mp3-cbr192:15,high:24:mp3-cbr192:15').split(',').map((s) => { const [preset, n, codec, secs] = s.split(':'); return { preset, N: +n, codec, secs: secs ? +secs : seconds }; });
const fixtures = Object.fromEntries(ensureFixtures().map((c) => [c.id, c]));
const exe = process.env.E2E_CHROMIUM || ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find(existsSync) || undefined;

const files = {
  '/processor.js': ['text/javascript', join(here, 'build/processor.js')],
  '/decoder.worker.js': ['text/javascript', join(here, 'build/decoder.worker.js')],
  '/page.js': ['text/javascript', join(here, 'build/page.js')],
  '/myco_audio.wasm': ['application/wasm', CORE_WASM],
  '/myco_audio_decode.wasm': ['application/wasm', DEC_WASM],
};
for (const c of Object.values(fixtures)) files['/' + basename(c.path)] = ['application/octet-stream', c.path];
const srv = http.createServer((req, res) => {
  const e = files[req.url.split('?')[0]];
  if (e) { res.setHeader('content-type', e[0]); res.end(readFileSync(e[1])); return; }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body>stream spike<script type="module" src="/page.js"></script></body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
const results = [];
try {
  const pg = await browser.newPage();
  pg.on('console', (m) => console.error('[page]', m.text()));
  pg.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await pg.goto(`http://127.0.0.1:${port}/`);
  await pg.waitForFunction(() => typeof globalThis.runCase === 'function');
  const ua = await pg.evaluate(() => navigator.userAgent);
  for (const cfg of configs) {
    const fx = fixtures[cfg.codec];
    const rs = [];
    for (let r = 0; r < runs; r++) {
      // a fresh page per run: new AudioContext, worker and worklet every time
      await pg.goto(`http://127.0.0.1:${port}/`);
      await pg.waitForFunction(() => typeof globalThis.runCase === 'function');
      const res = await pg.evaluate((o) => globalThis.runCase(o), { N: cfg.N, mixed: MIXED[cfg.preset], seconds: cfg.secs, hint: fx.hint, file: basename(fx.path), loop: true, realtime: !offline, killWorkerAt: control ? 3 : 0 });
      rs.push(res);
      console.error(`${cfg.preset} N=${cfg.N} ${cfg.codec} run ${r + 1}/${runs}: refused ${res.streamEventError}, starved reports ${res.starvedVoiceReports}/events ${res.streamEventStarved}, underruns ${res.underruns} (${res.underrunFrames} fr), live max ${res.liveVoicesMax}, out peak ${res.outPeak.toFixed(3)}, status ${res.statusBlocks}, opened ${res.opened}, ctx ${(res.ctxTimeAtEnd - res.ctxTimeAtPlay).toFixed(1)} s / wall ${(res.wallMsRun / 1000).toFixed(1)} s, errors ${res.errors.concat(res.workerErrors).join('|') || '-'}`);
    }
    results.push({ ...cfg, runs: rs });
  }
  saveJson(opt('--tag', '') ? `q3_${opt('--tag')}.json` : offline ? 'q3_offline.json' : 'q3.json', { date: new Date().toISOString(), ua, seconds, runs, offline, results });
  console.log(`\nQ3 Chromium (${ua.match(/Chrome\/[\d.]+/)?.[0]}), ${offline ? 'OfflineAudioContext (smoke)' : 'real-time AudioContext, null sink'}, ${runs} runs x ${seconds} s per config. starved = core stream-starvation reports (STATUS starved + stream event 1); underruns = shell probe (drift vs wall clock). Totals over runs.\n`);
  console.log('| preset | rings | N (streams) | codec | starved (sum) | stream evt 1 (sum) | stream evt 3 = refused/error (sum) | underruns (sum) | underrun frames | late cmds | live voices (max) | output peak | status blocks | streams opened | audio s / wall s |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of results) {
    const s = (k) => c.runs.reduce((a, r) => a + r[k], 0);
    console.log(`| ${c.preset} | ${c.runs[0].ringsExpected} | ${c.N} | ${c.codec} (${c.secs} s) | ${s('starvedVoiceReports')} | ${s('streamEventStarved')} | ${s('streamEventError')} | ${s('underruns')} | ${s('underrunFrames')} | ${s('lateCommands')} | ${Math.max(...c.runs.map((r) => r.liveVoicesMax))} | ${f(Math.min(...c.runs.map((r) => r.outPeak)), 3)} | ${median(c.runs.map((r) => r.statusBlocks))} | ${Math.min(...c.runs.map((r) => r.opened))} | ${f(median(c.runs.map((r) => r.ctxTimeAtEnd - r.ctxTimeAtPlay)), 1)} / ${f(median(c.runs.map((r) => r.wallMsRun / 1000)), 1)} |`);
  }
} finally { await browser.close(); srv.close(); }
