// Bundles live.ts (which imports the real testing.ts loopback host and the wire) with esbuild into build/. Nothing in src/ changes.
import { build } from "../../../../node_modules/esbuild-wasm/lib/main.js";
import { mkdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "build/wasm"), { recursive: true });
// testing.ts reads ./wasm/myco_audio.wasm relative to its own URL; once bundled that is build/wasm: link the committed binary there.
const link = join(here, "build/wasm/myco_audio.wasm");
if (existsSync(link)) rmSync(link);
symlinkSync(join(here, "../../../../src/plugins/audio/runtime/wasm/myco_audio.wasm"), link);
await build({ entryPoints: [join(here, "live.ts")], bundle: true, format: "esm", platform: "node", target: "es2022", outfile: join(here, "build/live.mjs"), logLevel: "warning", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
console.log("built live");
