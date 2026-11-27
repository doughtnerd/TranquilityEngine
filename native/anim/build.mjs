#!/usr/bin/env node
// `npm run build:anim` (ADR 0370): compiles native/anim to WebAssembly with simd128 and writes the module, its
// wasm-bindgen glue (setup calls only) and hash.json to src/plugins/animation/runtime/wasm/, which is committed, so
// the engine builds without Rust. Also regenerates the wire constants (wasm/wire/<family>.ts) and their vectors. Then
// builds the editor's compile module (anim-editor-wasm, T19/D79: compression and bakes, never shipped in games) the same
// way into wasm/editor/, with its own hash.json and size gate.
// Modelled on native/nav/build.mjs (wasm-bindgen pin) and native/audio/build.mjs (wire generator, source hash, size gate).
// Needs the toolchain pinned in rust-toolchain.toml, `rustup target add wasm32-unknown-unknown`, and wasm-bindgen-cli
// at the version pinned in Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configRustflags, wasmBuildEnv } from "../rustflags.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/plugins/animation/runtime/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
const OUT_NAME = "myco_anim";
/**
 * The wasm's size tripwire (ADR 0370): a guard against accidental growth, not a design limit (CLAUDE.md). Set from the
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
 * Raised by T40 (2026-11-22): the rig node family links the anim-rig solvers into the module for the first time (two-bone,
 * CCD, FABRIK, full-body IK, look-at, aim, grounder, spring chains, copy/limit/damp, stride, orientation and motion warping,
 * distance matching) plus the rig wire family and its views: 491,064 -> 637,130 bytes. + 20% = 764,556 B -> 745 KB.
 * Raised by T41 node half + T44r (2026-11-22): the retarget setup calls (bone-map guessing ~62 KB of name heuristics,
 * the raw bake ~30 KB, map building, profile decoding, the mirror table), the RETARGET node with its skeleton scope and
 * the two-bone pinning pass, the physics family (ragdoll descriptions and builder, drive targets, the physical pose,
 * get-up, 6 records) take the module from 491,064 to 695,567 bytes; + 20% = 834,680 B -> 815 KB.
 * Merged T40g + T41g/T44r (coordinator, 2026-11-22): together 831,834 bytes; + 20% = 998,201 B -> 975 KB.
 * Reset by T82r (2026-11-22): the function-name and producers sections are no longer shipped (-79 KB; they cost
 * nothing at run time, and MYCO_ANIM_KEEP_NAMES=1 keeps them for profiling), against +14 KB of T82r's caches and
 * benchmark-driven changes and T42g/T45 already in: 893,247 -> 827,697 bytes. + 20% = 993,236 B -> 970 KB.
 * Raise it with a line in docs/design/animation/build-log.md saying why; never cut a feature to stay under it.
 */
const SIZE_LIMIT = 970 * 1024;

/** The editor's compile module (T19, D79): a separate cdylib the editor's worker and the exporters load, never games. */
const editorOut = fileURLToPath(new URL("../../src/plugins/animation/runtime/wasm/editor/", import.meta.url));
const EDITOR_OUT_NAME = "myco_anim_editor";
/**
 * The editor module's size tripwire, separate from the runtime's (it never ships in a game, so it guards only the editor's
 * download and the exporter's). Set by T19 (2026-11-23) from its first build plus 20%, rounded: the compressor with its
 * f64 reference, the skeleton compile, the compressed retarget bake and the pose-database bake measured 349,312 bytes;
 * + 20% = 419,174 B -> 410 KB. Raise it with a line in docs/design/animation/build-log.md saying why.
 * Raised by T45t (2026-11-23): the fuel pass for third-party node modules (anim-meter on wasmparser's validator with the
 * simd128 operator set, and wasm-encoder to re-encode) links into the editor module so the editor's loader and exports
 * can meter modules: 349,312 -> 1,012,652 bytes. The validator is the bulk and can't be cut (the pass must refuse
 * modules outside the allowed proposal set). + 20% = 1,215,182 B -> 1190 KB.
 */
const EDITOR_SIZE_LIMIT = 1190 * 1024;

/** The environment of host tools (gen_wire, wasm-bindgen): RUSTFLAGS are dropped, so nothing but the configs applies. */
function hostEnv() {
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS;
  return env;
}

/** Runs `cmd args` in native/anim with inherited stdio, in `env` (the host tools' by default). */
function run(cmd, args, env = hostEnv()) {
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

/**
 * Builds anim-wasm for wasm32 in release (+simd128 from .cargo/config.toml, paths remapped by ../rustflags.mjs) and runs
 * wasm-bindgen into `out`. The
 * function-name and producers sections are dropped (T82r: 79 KB, 9% of the module, nothing at run time); set
 * MYCO_ANIM_KEEP_NAMES=1 to keep the names for a profile (`node --cpu-prof` then names the wasm functions). That build
 * isn't for committing.
 */
function buildWasm(crate, dir, name) {
  // .cargo/config.toml's +simd128, and the paths remapped so any checkout builds the same bytes (ADR 0432).
  run("cargo", ["build", "-p", crate, "--target", TARGET, "--release"], wasmBuildEnv(configRustflags(root)));
  mkdirSync(dir, { recursive: true });
  const strip = process.env.MYCO_ANIM_KEEP_NAMES === "1" ? [] : ["--remove-name-section", "--remove-producers-section"];
  run("wasm-bindgen", [`target/${TARGET}/release/${crate.replace(/-/g, "_")}.wasm`, "--target", "web", "--out-dir", dir, "--out-name", name, "--omit-default-module-path", ...strip]);
  return `${dir}${name}_bg.wasm`;
}

/** Fails the build when the wasm at `path` passes `limit` (the constant `constant` in this file); returns its size. */
function gate(path, name, limit, constant) {
  const bytes = statSync(path).size;
  const kb = (bytes / 1024).toFixed(1);
  if (limit > 0 && bytes > limit) {
    console.error(
      `[build:anim] ${name}_bg.wasm is ${bytes} bytes (${kb} KB), over its ${limit / 1024} KB size gate.\n` +
        "[build:anim] The gate is a tripwire against accidental growth, not a design limit (CLAUDE.md): look for bloat first;\n" +
        `[build:anim] if the growth is wanted, raise ${constant} in native/anim/build.mjs and record why in docs/design/animation/build-log.md.`,
    );
    process.exit(1);
  }
  console.log(`[build:anim] ${name}_bg.wasm: ${bytes} bytes (${kb} KB), gate ${limit / 1024} KB`);
  return bytes;
}

/** Loads the built module through its glue and returns the source hash it embeds. */
async function readSourceHash(dir, name, path) {
  const glue = await import(pathToFileURL(`${dir}${name}.js`).href);
  glue.initSync({ module: readFileSync(path) });
  return glue.source_hash();
}

/** Builds one crate's module into `dir`, gates its size and writes its hash.json. */
async function buildModule(crate, dir, name, limit, constant) {
  const wasm = buildWasm(crate, dir, name);
  const bytes = gate(wasm, name, limit, constant);
  const sourceHash = await readSourceHash(dir, name, wasm);
  const json = { sourceHash, bytes: { [`${name}_bg.wasm`]: bytes } };
  writeFileSync(`${dir}hash.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:anim] source hash ${sourceHash}; wrote ${dir}`);
}

async function main() {
  checkToolchain();
  run("cargo", ["run", "-p", "anim-wire", "--bin", "gen_wire"]);
  await buildModule("anim-wasm", out, OUT_NAME, SIZE_LIMIT, "SIZE_LIMIT");
  await buildModule("anim-editor-wasm", editorOut, EDITOR_OUT_NAME, EDITOR_SIZE_LIMIT, "EDITOR_SIZE_LIMIT");
}

await main();
