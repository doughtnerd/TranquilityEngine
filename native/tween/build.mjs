#!/usr/bin/env node
// `npm run build:tween` (ADR 0420): compiles the standalone tween module (native/tween: myco-tween's table, a curve
// store and a sequence player, for UI animation without the animation plugin) to WebAssembly with simd128, and writes
// the module, its wasm-bindgen glue and hash.json to src/engine/tween/wasm/, which is committed, so the engine builds
// without Rust. First regenerates the wire constants the engine's tween backend speaks to it with
// (src/engine/tween/wasm/wire/*.ts, anim-wire's gen_wire, which writes the animation core's too).
// Modelled on native/anim/build.mjs (wasm-bindgen pin, source hash, size gate). No wasm-opt pass, as build:anim.
// Needs the toolchain pinned in rust-toolchain.toml, `rustup target add wasm32-unknown-unknown`, and wasm-bindgen-cli
// at the version pinned in Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { configRustflags, wasmBuildEnv } from "../rustflags.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const animRoot = fileURLToPath(new URL("../anim/", import.meta.url));
const out = fileURLToPath(new URL("../../src/engine/tween/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
const CRATE = "myco_tween_wasm";
const OUT_NAME = "myco_tween";
/**
 * The wasm's size tripwire (ADR 0420): a guard against accidental growth, not a design limit (CLAUDE.md). Set from the
 * first full build plus 20%, rounded. The spike's module (tweens and curves only) measured 30,077 bytes (36 KB gate in
 * the ADR); the accepted build adds the sequence player (the owner's choice in 0420), its timeline records and the
 * source hash: 45,584 bytes (2026-11-26, after keeping general sorts and float formatting out), + 20% = 54,701 B -> 53 KB.
 * Raise it with a line in docs/architecture/implementation-status.md's 0420 row saying why; never cut a feature to stay
 * under it.
 */
const SIZE_LIMIT = 53 * 1024;

/** The environment of host tools (gen_wire, wasm-bindgen): RUSTFLAGS are dropped, so nothing but the configs applies. */
function hostEnv() {
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS;
  return env;
}

/** Runs `cmd args` in `cwd` with inherited stdio, in `env` (the host tools' by default). */
function run(cmd, args, cwd = root, env = hostEnv()) {
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit", env });
  } catch {
    console.error(`[build:tween] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

/** Fails with a fix-it message unless cargo runs, the wasm32 target is installed and wasm-bindgen-cli matches the pin. */
function checkToolchain() {
  try {
    execFileSync("cargo", ["--version"], { cwd: root, stdio: "ignore" });
  } catch {
    console.error("[build:tween] cargo is not on PATH. Install Rust via rustup (https://rustup.rs), then reopen the shell.");
    process.exit(1);
  }
  let installed = null;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
  } catch {
    // rustup is absent (a non-rustup toolchain): cargo reports any gap.
  }
  if (installed !== null && !installed.split(/\r?\n/).map((line) => line.trim()).includes(TARGET)) {
    console.error(`[build:tween] the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`);
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
    console.error(`[build:tween] wasm-bindgen-cli ${pinned} is needed (found ${bindgen || "none"}): cargo install wasm-bindgen-cli --version ${pinned} --locked`);
    process.exit(1);
  }
  console.log("[build:tween] toolchain ok");
}

async function main() {
  checkToolchain();
  run("cargo", ["run", "-p", "anim-wire", "--bin", "gen_wire"], animRoot);
  // .cargo/config.toml's +simd128, and the paths remapped so any checkout builds the same bytes (ADR 0428).
  run("cargo", ["build", "--target", TARGET, "--release"], root, wasmBuildEnv(configRustflags(root)));
  mkdirSync(out, { recursive: true });
  // As build:anim: the name and producers sections are dropped (nothing at run time).
  run("wasm-bindgen", [
    `target/${TARGET}/release/${CRATE}.wasm`,
    "--target", "web", "--out-dir", out, "--out-name", OUT_NAME, "--omit-default-module-path",
    "--remove-name-section", "--remove-producers-section",
  ]);
  const wasm = `${out}${OUT_NAME}_bg.wasm`;
  const bytes = statSync(wasm).size;
  const kb = (bytes / 1024).toFixed(1);
  if (bytes > SIZE_LIMIT) {
    console.error(
      `[build:tween] ${OUT_NAME}_bg.wasm is ${bytes} bytes (${kb} KB), over its ${SIZE_LIMIT / 1024} KB size gate.\n` +
        "[build:tween] The gate is a tripwire against accidental growth, not a design limit (CLAUDE.md): look for bloat first;\n" +
        "[build:tween] if the growth is wanted, raise SIZE_LIMIT in native/tween/build.mjs and record why.",
    );
    process.exit(1);
  }
  const gz = gzipSync(readFileSync(wasm), { level: 9 }).length;
  console.log(`[build:tween] ${OUT_NAME}_bg.wasm: ${bytes} bytes (${kb} KB, ${gz} gzip), gate ${SIZE_LIMIT / 1024} KB`);
  const glue = await import(pathToFileURL(`${out}${OUT_NAME}.js`).href);
  glue.initSync({ module: readFileSync(wasm) });
  const sourceHash = glue.source_hash();
  const json = { sourceHash, bytes: { [`${OUT_NAME}_bg.wasm`]: bytes } };
  writeFileSync(`${out}hash.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:tween] source hash ${sourceHash}; wrote ${out}`);
}

await main();
