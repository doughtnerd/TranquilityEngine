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

void [execFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync];
void [root, out, TARGET, MIXER_LIMIT, DECODER_LIMIT, WASM_RUSTFLAGS, READ_MEMORY_PAGES];

/** Runs `cmd args` in native/audio with inherited stdio; `env` adds variables. */
function run(cmd, args, env = {}) {
  void [cmd, args, env];
  throw new Error("not implemented: A0.1-L1");
}

/** Fails with a fix-it message unless cargo runs and the wasm32 target is installed. */
function checkToolchain() {
  throw new Error("not implemented: A0.1-L1");
}

/** Runs audio-wire's generator, or logs a skip while crates/audio-wire doesn't exist yet. */
function genWire() {
  throw new Error("not implemented: A0.1-L1");
}

/** Builds audio-wasm for wasm32 in release; returns the built .wasm's path. */
function buildWasm({ testHooks }) {
  void testHooks;
  throw new Error("not implemented: A0.1-L1");
}

/** Runs `wasm-opt -O3` on `path` in place if wasm-opt is on PATH; logs a skip otherwise. */
function optimize(path) {
  void path;
  throw new Error("not implemented: A0.1-L1");
}

/** Exits 1 when `path` is larger than `limit` bytes; returns its size. */
function gate(path, limit, label) {
  void [path, limit, label];
  throw new Error("not implemented: A0.1-L1");
}

/** Instantiates the wasm on a fresh Memory and reads its source hash (hex) and ABI version ("1.0"). */
function readIdentity(path) {
  void path;
  throw new Error("not implemented: A0.1-L1");
}

/** Writes hash.json. */
function writeHashJson(identity, bytes) {
  void [identity, bytes];
  throw new Error("not implemented: A0.1-L1");
}

function main() {
  throw new Error("not implemented: A0.1-L1");
}

void [run, checkToolchain, genWire, buildWasm, optimize, gate, readIdentity, writeHashJson];
main();
