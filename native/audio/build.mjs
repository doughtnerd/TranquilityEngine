#!/usr/bin/env node
// `npm run build:audio` (ADR 0157, api-and-models §5): compiles native/audio to WebAssembly and writes
// myco_audio.wasm, the test-hooks wasm and hash.json to src/plugins/audio/runtime/wasm/, which is
// committed, so the engine builds without Rust. Modelled on native/nav/build.mjs, without
// wasm-bindgen: the core's exports are plain `extern "C"` functions over imported memory.
// Needs the toolchain pinned in rust-toolchain.toml and `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/plugins/audio/runtime/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
/** The mixer's size gate (ADR 0157): 150 KB. */
const MIXER_LIMIT = 150 * 1024;
/** The decoder's size gate (M1b): 900 KB. */
const DECODER_LIMIT = 900 * 1024;
/** Only +simd128 here: --import-memory and the 256 KB stack are link args in audio-wasm's build.rs. */
const WASM_RUSTFLAGS = "-C target-feature=+simd128";
/** Pages of the Memory the hash read instantiates the wasm with (enough for its data and stack). */
const READ_MEMORY_PAGES = 64;

/** Runs `cmd args` in native/audio with inherited stdio; `env` adds variables. */
function run(cmd, args, env = {}) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  } catch {
    console.error(`[build:audio] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

/** Fails with a fix-it message unless cargo runs and the wasm32 target is installed. */
function checkToolchain() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("[build:audio] cargo is not on PATH. Install Rust via rustup (https://rustup.rs), then reopen the shell.");
    process.exit(1);
  }
  let installed = null;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
  } catch {
    // rustup is absent (e.g. a non-rustup toolchain): the target check is skipped, cargo reports any gap.
  }
  if (installed !== null && !installed.split(/\r?\n/).map((line) => line.trim()).includes(TARGET)) {
    console.error(`[build:audio] the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`);
    process.exit(1);
  }
  console.log("[build:audio] toolchain ok");
}

/** Runs audio-wire's generator, or logs a skip while crates/audio-wire doesn't exist yet. */
function genWire() {
  if (!existsSync(fileURLToPath(new URL("crates/audio-wire/Cargo.toml", import.meta.url)))) {
    console.log("[build:audio] crates/audio-wire absent, skipping gen_wire");
    return;
  }
  run("cargo", ["run", "-p", "audio-wire", "--bin", "gen_wire"]);
}

/** Builds audio-wasm for wasm32 in release; returns the built .wasm's path. */
function buildWasm({ testHooks }) {
  const args = ["build", "-p", "audio-wasm", "--target", TARGET, "--release"];
  if (testHooks) args.push("--features", "test-hooks", "--target-dir", "target/test-hooks");
  run("cargo", args, { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: WASM_RUSTFLAGS });
  const dir = testHooks ? "target/test-hooks" : "target";
  return fileURLToPath(new URL(`${dir}/${TARGET}/release/myco_audio.wasm`, import.meta.url));
}

/** Runs `wasm-opt -O3` on `path` in place if wasm-opt is on PATH; logs a skip otherwise. */
function optimize(path) {
  try {
    execFileSync("wasm-opt", ["--version"], { stdio: "ignore" });
  } catch {
    console.log(`[build:audio] wasm-opt not on PATH, skipping -O3 for ${path}`);
    return;
  }
  run("wasm-opt", ["-O3", path, "-o", path]);
}

/** Exits 1 when `path` is larger than `limit` bytes; returns its size. */
function gate(path, limit, label) {
  const size = statSync(path).size;
  console.log(`[build:audio] ${label}: ${size} bytes (${(size / 1024).toFixed(1)} KB), limit ${limit / 1024} KB`);
  if (size > limit) {
    console.error(`[build:audio] ${label} is ${size - limit} bytes over its ${limit / 1024} KB limit (ADR 0157). Shrink what the wasm links, then rebuild.`);
    process.exit(1);
  }
  return size;
}

/** Instantiates the wasm on a fresh Memory and reads its source hash (hex) and ABI version ("1.0"). */
function readIdentity(path) {
  const memory = new WebAssembly.Memory({ initial: READ_MEMORY_PAGES });
  const module = new WebAssembly.Module(readFileSync(path));
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const sourceHash = Buffer.from(memory.buffer, exports.myco_audio_source_hash(), 16).toString("hex");
  const v = exports.myco_audio_abi_version();
  return { sourceHash, abiVersion: `${v >> 8}.${v & 0xff}` };
}

/** Writes hash.json. */
function writeHashJson(identity, bytes) {
  const path = `${out}hash.json`;
  const json = { sourceHash: identity.sourceHash, abiVersion: identity.abiVersion, bytes };
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:audio] wrote ${path}`);
}

function main() {
  checkToolchain();
  genWire();
  const mixerBuild = buildWasm({ testHooks: false });
  const testBuild = buildWasm({ testHooks: true });
  optimize(mixerBuild);
  optimize(testBuild);
  const mixerBytes = gate(mixerBuild, MIXER_LIMIT, "myco_audio.wasm");
  // The decoder (M1b) is gated only once its crate exists; inert until then.
  if (existsSync(fileURLToPath(new URL("crates/audio-decode/Cargo.toml", import.meta.url)))) {
    gate(fileURLToPath(new URL(`target/${TARGET}/release/myco_audio_decode.wasm`, import.meta.url)), DECODER_LIMIT, "myco_audio_decode.wasm");
  }
  const testBytes = statSync(testBuild).size;
  console.log(`[build:audio] myco_audio_test_hooks.wasm: ${testBytes} bytes (${(testBytes / 1024).toFixed(1)} KB), not gated`);

  mkdirSync(`${out}testing`, { recursive: true });
  copyFileSync(mixerBuild, `${out}myco_audio.wasm`);
  copyFileSync(testBuild, `${out}testing/myco_audio_test_hooks.wasm`);

  const identity = readIdentity(`${out}myco_audio.wasm`);
  console.log(`[build:audio] source hash ${identity.sourceHash}, ABI ${identity.abiVersion}`);
  writeHashJson(identity, { "myco_audio.wasm": mixerBytes, "testing/myco_audio_test_hooks.wasm": testBytes });
}

main();
