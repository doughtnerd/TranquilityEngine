#!/usr/bin/env node
// ADR 0420 spike: builds the standalone tween module (native/tween) for wasm32 in release, runs wasm-bindgen into
// native/tween/pkg/ (gitignored, never committed), then prints its size raw, gzip and brotli, with and without
// Binaryen's `wasm-opt -O3` (skipped when wasm-opt isn't on PATH). `node native/tween/build.mjs`.
// The real module would be `npm run build:tween` into src/engine/tween/wasm/ with a size gate, like native/audio/build.mjs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = `${root}pkg/`;
const env = { ...process.env };
delete env.RUSTFLAGS;
delete env.CARGO_ENCODED_RUSTFLAGS;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });

run("cargo", ["build", "--target", "wasm32-unknown-unknown", "--release"]);
mkdirSync(out, { recursive: true });
// As build:anim: the name and producers sections are dropped.
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/myco_tween_wasm.wasm",
  "--target", "web", "--out-dir", out, "--out-name", "myco_tween", "--omit-default-module-path",
  "--remove-name-section", "--remove-producers-section",
]);

const wasm = `${out}myco_tween_bg.wasm`;
const sizes = (path) => {
  const bytes = readFileSync(path);
  const gz = gzipSync(bytes, { level: 9 }).length;
  const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  return { raw: statSync(path).size, gzip: gz, brotli: br };
};
const rows = [["wasm-bindgen output", sizes(wasm)]];
let haveOpt = true;
try {
  execFileSync("wasm-opt", ["--version"], { stdio: "ignore" });
} catch {
  haveOpt = false;
  console.log("[tween spike] wasm-opt not on PATH: no -O3 / -Oz rows");
}
if (haveOpt) {
  for (const level of ["-O3", "-Oz"]) {
    const opt = `${out}myco_tween_bg${level}.wasm`;
    run("wasm-opt", [level, "--enable-simd", "--enable-bulk-memory", "--enable-sign-ext", "--enable-mutable-globals", "--enable-nontrapping-float-to-int", wasm, "-o", opt]);
    rows.push([`wasm-opt ${level}`, sizes(opt)]);
  }
}
const glue = sizes(`${out}myco_tween.js`);
console.log("\n| Build | Raw | gzip -9 | brotli 11 |\n|---|---:|---:|---:|");
for (const [name, s] of rows) console.log(`| ${name} | ${s.raw} | ${s.gzip} | ${s.brotli} |`);
console.log(`| JS glue (myco_tween.js) | ${glue.raw} | ${glue.gzip} | ${glue.brotli} |`);
