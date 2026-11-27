#!/usr/bin/env node
// `npm run build:layout` (ADR 0433): compiles native/layout (Taffy behind layout-core and the layout-wasm boundary)
// to WebAssembly and writes the module and its wasm-bindgen glue to src/engine/ui/taffy/wasm/, which is committed, so
// the engine builds without Rust. Paths are remapped as the other native builds do (ADR 0432), so any checkout builds
// the same bytes. Needs `rustup target add wasm32-unknown-unknown` and wasm-bindgen-cli at the version pinned in
// Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { wasmBuildEnv } from "../rustflags.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/engine/ui/taffy/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
const OUT_NAME = "myco_layout";
/**
 * The wasm's size tripwire (ADR 0433): a guard against accidental growth, not a design limit (CLAUDE.md). Set from the
 * first build (flexbox, grid and block layout at opt-level 3: 369,315 bytes, 124 KB gzip, 2026-11-27) plus 20%, rounded
 * up. Yoga 3.2.1, which it replaces, was 71,736 bytes (28.8 KB gzip). Raise it with a line in
 * docs/architecture/implementation-status.md's 0433 row saying why; never cut a feature to stay under it.
 */
const SIZE_LIMIT = 440 * 1024;

function run(cmd, args, env = process.env) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
  } catch {
    console.error(`[build:layout] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

const pinned = /wasm-bindgen = "=([\d.]+)"/.exec(readFileSync(new URL("Cargo.toml", import.meta.url), "utf8"))?.[1];
let installed = "";
try {
  installed = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1];
} catch {
  // reported below
}
if (installed !== pinned) {
  console.error(`[build:layout] wasm-bindgen-cli ${pinned} is needed (found ${installed || "none"}): cargo install wasm-bindgen-cli --version ${pinned} --locked`);
  process.exit(1);
}

run("cargo", ["build", "-p", "layout-wasm", "--target", TARGET, "--release"], wasmBuildEnv());
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("wasm-bindgen", [
  `target/${TARGET}/release/layout_wasm.wasm`,
  "--target", "web", "--out-dir", out, "--out-name", OUT_NAME, "--omit-default-module-path",
  "--remove-name-section", "--remove-producers-section",
]);
const wasm = `${out}${OUT_NAME}_bg.wasm`;
const bytes = statSync(wasm).size;
const gz = gzipSync(readFileSync(wasm), { level: 9 }).length;
const kb = (bytes / 1024).toFixed(1);
if (bytes > SIZE_LIMIT) {
  console.error(
    `[build:layout] ${OUT_NAME}_bg.wasm is ${bytes} bytes (${kb} KB), over its ${SIZE_LIMIT / 1024} KB size gate.\n` +
      "[build:layout] The gate is a tripwire against accidental growth, not a design limit (CLAUDE.md): look for bloat first;\n" +
      "[build:layout] if the growth is wanted, raise SIZE_LIMIT in native/layout/build.mjs and record why.",
  );
  process.exit(1);
}
console.log(`[build:layout] ${OUT_NAME}_bg.wasm: ${bytes} bytes (${kb} KB, ${gz} gzip), gate ${SIZE_LIMIT / 1024} KB; wrote ${out}`);
