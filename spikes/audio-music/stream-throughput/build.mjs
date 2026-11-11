// Bundles the REAL engine modules (decoder worker/handler, stream decoder, worklet processor + CoreDriver, wire) with
// esbuild into build/, so the spike measures the shipped code, not a copy. Nothing in src/ is touched.
import { build } from '/home/user/TranquilityEngine/node_modules/esbuild/lib/main.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const rt = join(repo, 'src/plugins/audio/runtime');
mkdirSync(join(here, 'build'), { recursive: true });
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning', sourcemap: false };
await Promise.all([
  // The real worker entry (decoder.worker.ts), unchanged.
  build({ ...common, entryPoints: [join(rt, 'decoder/decoder.worker.ts')], outfile: join(here, 'build/decoder.worker.js') }),
  // The real worklet processor (processor.ts -> CoreDriver -> core wasm).
  build({ ...common, entryPoints: [join(rt, 'worklet/processor.ts')], outfile: join(here, 'build/processor.js') }),
  // Node-side pieces: the real handler/StreamDecoder/DecoderWasm/credit/wire, imported by q1/q2 and the node worker.
  build({ ...common, platform: 'node', entryPoints: { engine: join(here, 'src/engineExports.ts') }, outdir: join(here, 'build') }),
  // The page harness for Chromium (CommandWriter-free: hand-written PLAY batch, real STATUS reader).
  build({ ...common, entryPoints: [join(here, 'src/page.ts')], outfile: join(here, 'build/page.js') }),
]);
console.log('built');
