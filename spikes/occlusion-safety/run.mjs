// One command: node spikes/occlusion-safety/run.mjs [--quick]
// Expected duration: about 3 minutes on 4 shared cores (scene + stand-in build with the error measurement ~50 s, cargo build and
// tests ~15 s warm / ~40 s cold, the 1080p-oracle measurement loop ~80 s). --quick evaluates every 6th camera frame (~1.5 min).
// Writes results.json and tables.md next to this file. Counts are deterministic; only the import-cost timings vary.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick');
const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(here, 'target') };
const sh = (cmd, args, opts = {}) => { console.log(`$ ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { cwd: here, stdio: 'inherit', env, ...opts }); };

if (!existsSync(join(here, 'node_modules', 'meshoptimizer'))) sh('npm', ['install', '--no-audit', '--no-fund']);
sh('node', ['build-scenes.mjs']);
sh('cargo', ['test', '--release', '--quiet']); // rules off == the spike's depth buffer, bit for bit; rules only shrink / push back
sh('cargo', ['build', '--release', '--quiet']);
sh(join(env.CARGO_TARGET_DIR, 'release', 'safety'), ['out/scenes.bin', 'out/results-raw.json', ...(quick ? ['--step', '6'] : [])]);
sh('node', ['report.mjs']);
console.log('\nwrote results.json and tables.md');
