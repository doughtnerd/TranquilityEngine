#!/usr/bin/env node
// `npm run build:anim` (ADR 0340): compiles native/anim to WebAssembly with simd128 and writes the module, its
// wasm-bindgen glue (setup calls only) and hash.json to src/plugins/animation/runtime/wasm/, which is committed, so
// the engine builds without Rust. Also regenerates the wire constants (wasm/wire/<family>.ts) and their vectors.
// Modelled on native/nav/build.mjs (wasm-bindgen pin) and native/audio/build.mjs (wire generator, source hash, size gate).
// Needs the toolchain pinned in rust-toolchain.toml, `rustup target add wasm32-unknown-unknown`, and wasm-bindgen-cli
// at the version pinned in Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/plugins/animation/runtime/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
const OUT_NAME = "myco_anim";
/**
 * The wasm's size tripwire (ADR 0340): a guard against accidental growth, not a design limit (CLAUDE.md). Set from the
 * first full build plus 20%, rounded: T02 (2026-11-22) built 25,206 bytes (stubs, init and source_hash), + 20% = 30,247 B -> 30 KB.
 * Raised by T13r (2026-11-22): the first build with a real core (the four format readers, compressed sampling with T20r's
 * binding tables and track windows, the graph interpreter, pose maths, inertialization) measured 292,316 bytes
 * (111 KB gzipped); the stub-based 30 KB gate never described a full build. + 20% = 350,779 B -> 345 KB.
 * Raised by T22r (2026-11-22): tweens and timelines (ten new boundary records with their codecs, the Penner easings, the tween table,
 * timeline instances with nested subclip evaluation, crossfade mixing and sequences, 33 new exports) take the module from 292,313 to
 * 361,549 bytes; + 20% = 433,859 B -> 425 KB.
 * Raised by T31 (2026-11-22): the complete graph runtime (state machines with the blend stack, conditions, requests,
 * travel tables; blend spaces with the Delaunay build; random selector, chooser; enum/bool/additive/time-scale/mirror;
 * slots with sections; linked graphs; sync groups; the debug walk; the graph and debug wire families) measured
 * 421,778 bytes after replacing load-time general sorts with an insertion sort (-52 KB). + 20% = 506,134 B -> 495 KB.
 * Merged T22r + T31 (coordinator, 2026-11-22): both together measured 491,064 bytes; + 20% = 589,277 B -> 580 KB.
 * Raise it with a line in docs/design/animation/build-log.md saying why; never cut a feature to stay under it.
 */
const SIZE_LIMIT = 580 * 1024;

/** Runs `cmd args` in native/anim with inherited stdio. RUSTFLAGS are dropped so .cargo/config.toml's +simd128 applies. */
function run(cmd, args) {
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS;
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
  } catch {
    console.error(`[build:anim] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

/** Fails with a fix-it message unless cargo runs, the wasm32 target is installed and wasm-bindgen-cli matches the pin. */
function checkToolchain() {
  try {
    execFileSync("cargo", ["--version"], { cwd: root, stdio: "ignore" });
  } catch {
    console.error("[build:anim] cargo is not on PATH. Install Rust via rustup (https://rustup.rs), then reopen the shell.");
    process.exit(1);
  }
  let installed = null;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
  } catch {
    // rustup is absent (a non-rustup toolchain): cargo reports any gap.
  }
  if (installed !== null && !installed.split(/\r?\n/).map((line) => line.trim()).includes(TARGET)) {
    console.error(`[build:anim] the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`);
    process.exit(1);
  }
  const pinned = /wasm-bindgen = "=([\d.]+)"/.exec(readFileSync(new URL("Cargo.toml", import.meta.url), "utf8"))?.[1];
  let bindgen = "";
  try {
    bindgen = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1];
  } catch {
    // reported below
  }
  if (bindgen !== pinned) {
    console.error(`[build:anim] wasm-bindgen-cli ${pinned} is needed (found ${bindgen || "none"}): cargo install wasm-bindgen-cli --version ${pinned} --locked`);
    process.exit(1);
  }
  console.log("[build:anim] toolchain ok");
}

/** Builds anim-wasm for wasm32 in release (+simd128 from .cargo/config.toml) and runs wasm-bindgen into `out`. */
function buildWasm() {
  run("cargo", ["build", "-p", "anim-wasm", "--target", TARGET, "--release"]);
  mkdirSync(out, { recursive: true });
  run("wasm-bindgen", [`target/${TARGET}/release/anim_wasm.wasm`, "--target", "web", "--out-dir", out, "--out-name", OUT_NAME, "--omit-default-module-path"]);
  return `${out}${OUT_NAME}_bg.wasm`;
}

/** Fails the build when the wasm passes SIZE_LIMIT; returns its size. */
function gate(path) {
  const bytes = statSync(path).size;
  const kb = (bytes / 1024).toFixed(1);
  if (SIZE_LIMIT > 0 && bytes > SIZE_LIMIT) {
    console.error(
      `[build:anim] ${OUT_NAME}_bg.wasm is ${bytes} bytes (${kb} KB), over its ${SIZE_LIMIT / 1024} KB size gate.\n` +
        "[build:anim] The gate is a tripwire against accidental growth, not a design limit (CLAUDE.md): look for bloat first;\n" +
        "[build:anim] if the growth is wanted, raise SIZE_LIMIT in native/anim/build.mjs and record why in docs/design/animation/build-log.md.",
    );
    process.exit(1);
  }
  console.log(`[build:anim] ${OUT_NAME}_bg.wasm: ${bytes} bytes (${kb} KB), gate ${SIZE_LIMIT / 1024} KB`);
  return bytes;
}

/** Loads the built module through its glue and returns the source hash it embeds. */
async function readSourceHash(path) {
  const glue = await import(pathToFileURL(`${out}${OUT_NAME}.js`).href);
  glue.initSync({ module: readFileSync(path) });
  return glue.source_hash();
}

async function main() {
  checkToolchain();
  run("cargo", ["run", "-p", "anim-wire", "--bin", "gen_wire"]);
  const wasm = buildWasm();
  const bytes = gate(wasm);
  const sourceHash = await readSourceHash(wasm);
  const json = { sourceHash, bytes: { [`${OUT_NAME}_bg.wasm`]: bytes } };
  writeFileSync(`${out}hash.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:anim] source hash ${sourceHash}; wrote ${out}`);
}

await main();
