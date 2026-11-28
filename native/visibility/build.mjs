#!/usr/bin/env node
// `npm run build:visibility` (ADR 0447): compiles native/visibility to WebAssembly with simd128 and writes the runtime
// module, its wasm-bindgen glue (setup calls only) and hash.json to src/engine/render/visibility/occlusion/wasm/, which is
// committed, so the engine builds without Rust. Then builds the editor and export module (vis-editor-wasm: import-time
// hole trimming of occluder stand-ins, never shipped in games) the same way into wasm/editor/, with its own hash.json and
// size gate. Modelled on native/anim/build.mjs (wasm-bindgen pin, source hash, size gate).
// Needs the toolchain pinned in rust-toolchain.toml, `rustup target add wasm32-unknown-unknown`, and wasm-bindgen-cli at
// the version pinned in Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configRustflags, wasmBuildEnv } from "../rustflags.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/engine/render/visibility/occlusion/wasm/", import.meta.url));
const editorOut = fileURLToPath(new URL("../../src/engine/render/visibility/occlusion/wasm/editor/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
const OUT_NAME = "myco_visibility";
const EDITOR_OUT_NAME = "myco_visibility_editor";
/**
 * The runtime wasm's size tripwire (ADR 0447): a guard against accidental growth, not a design limit (CLAUDE.md). Set
 * from the first full build plus 20%, rounded up to the KB: T3 (2026-11-28) built 41,806 bytes (18.3 KB gzipped: the rasteriser
 * with its scalar reference, setup and clipping, the occludee test, the conservativeness rules, the boundary), + 20% =
 * 50,167 B -> 49 KB. Raise it with a line in docs/design/lod-occlusion/build-log.md saying why;
 * never cut a feature to stay under it.
 */
const SIZE_LIMIT = 49 * 1024;
/**
 * The editor module's size tripwire, separate from the runtime's (it never ships in a game, so it guards only the editor's
 * download and the exporter's). Set from its first build plus 20%, rounded up to the KB: T3 (2026-11-28) built
 * 49,076 bytes (hole trimming with its BVH and sampler, the neighbour table, the boundary), + 20% = 58,891 B -> 58 KB. Raise it with a line in docs/design/lod-occlusion/build-log.md saying why.
 */
const EDITOR_SIZE_LIMIT = 58 * 1024;

/** The environment of host tools (wasm-bindgen): RUSTFLAGS are dropped, so nothing but the configs applies. */
function hostEnv() {
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS;
  return env;
}

/** Runs `cmd args` in native/visibility with inherited stdio, in `env` (the host tools' by default). */
function run(cmd, args, env = hostEnv()) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
  } catch {
    console.error(`[build:visibility] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

/** Fails with a fix-it message unless cargo runs, the wasm32 target is installed and wasm-bindgen-cli matches the pin. */
function checkToolchain() {
  try {
    execFileSync("cargo", ["--version"], { cwd: root, stdio: "ignore" });
  } catch {
    console.error("[build:visibility] cargo is not on PATH. Install Rust via rustup (https://rustup.rs), then reopen the shell.");
    process.exit(1);
  }
  let installed = null;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
  } catch {
    // rustup is absent (a non-rustup toolchain): cargo reports any gap.
  }
  if (installed !== null && !installed.split(/\r?\n/).map((line) => line.trim()).includes(TARGET)) {
    console.error(`[build:visibility] the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`);
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
    console.error(`[build:visibility] wasm-bindgen-cli ${pinned} is needed (found ${bindgen || "none"}): cargo install wasm-bindgen-cli --version ${pinned} --locked`);
    process.exit(1);
  }
  console.log("[build:visibility] toolchain ok");
}

/**
 * Builds a crate for wasm32 in release (+simd128 from .cargo/config.toml, paths remapped by ../rustflags.mjs) and runs
 * wasm-bindgen into `dir`. The function-name and producers sections are dropped (nothing at run time); set
 * MYCO_VIS_KEEP_NAMES=1 to keep the names for a profile. That build isn't for committing.
 */
function buildWasm(crate, dir, name) {
  // .cargo/config.toml's +simd128, and the paths remapped so any checkout builds the same bytes (ADR 0432).
  run("cargo", ["build", "-p", crate, "--target", TARGET, "--release"], wasmBuildEnv(configRustflags(root)));
  mkdirSync(dir, { recursive: true });
  const strip = process.env.MYCO_VIS_KEEP_NAMES === "1" ? [] : ["--remove-name-section", "--remove-producers-section"];
  const target = process.env.CARGO_TARGET_DIR ? `${process.env.CARGO_TARGET_DIR}/${TARGET}` : `target/${TARGET}`;
  run("wasm-bindgen", [`${target}/release/${crate.replace(/-/g, "_")}.wasm`, "--target", "web", "--out-dir", dir, "--out-name", name, "--omit-default-module-path", ...strip]);
  return `${dir}${name}_bg.wasm`;
}

/** Fails the build when the wasm at `path` passes `limit` (the constant `constant` in this file); returns its size. */
function gate(path, name, limit, constant) {
  const bytes = statSync(path).size;
  const kb = (bytes / 1024).toFixed(1);
  if (limit > 0 && bytes > limit) {
    console.error(
      `[build:visibility] ${name}_bg.wasm is ${bytes} bytes (${kb} KB), over its ${limit / 1024} KB size gate.\n` +
        "[build:visibility] The gate is a tripwire against accidental growth, not a design limit (CLAUDE.md): look for bloat first;\n" +
        `[build:visibility] if the growth is wanted, raise ${constant} in native/visibility/build.mjs and record why in docs/design/lod-occlusion/build-log.md.`,
    );
    process.exit(1);
  }
  console.log(`[build:visibility] ${name}_bg.wasm: ${bytes} bytes (${kb} KB), gate ${limit / 1024} KB`);
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
  console.log(`[build:visibility] source hash ${sourceHash}; wrote ${dir}`);
}

async function main() {
  checkToolchain();
  await buildModule("vis-wasm", out, OUT_NAME, SIZE_LIMIT, "SIZE_LIMIT");
  await buildModule("vis-editor-wasm", editorOut, EDITOR_OUT_NAME, EDITOR_SIZE_LIMIT, "EDITOR_SIZE_LIMIT");
}

await main();
