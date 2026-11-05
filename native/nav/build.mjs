#!/usr/bin/env node
// `npm run build:nav` (ADR 0065): compiles native/nav to WebAssembly and writes the module and its
// JS glue to src/engine/nav/wasm/, which is committed, so the engine builds without Rust. Needs
// `rustup target add wasm32-unknown-unknown` and wasm-bindgen-cli at the version pinned in Cargo.toml.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/engine/nav/wasm/", import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

const pinned = /wasm-bindgen = "=([\d.]+)"/.exec(readFileSync(new URL("Cargo.toml", import.meta.url), "utf8"))?.[1];
let installed = "";
try {
  installed = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(" ")[1];
} catch {
  // reported below
}
if (installed !== pinned) {
  console.error(`[build:nav] wasm-bindgen-cli ${pinned} is needed (found ${installed || "none"}): cargo install wasm-bindgen-cli --version ${pinned} --locked`);
  process.exit(1);
}

run("cargo", ["build", "-p", "nav-wasm", "--target", "wasm32-unknown-unknown", "--release"]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("wasm-bindgen", ["target/wasm32-unknown-unknown/release/nav_wasm.wasm", "--target", "web", "--out-dir", out, "--out-name", "myco_nav", "--omit-default-module-path"]);
console.log(`[build:nav] wrote ${out}`);
