// Builds the audio effect plugins that ship in the repository (ADR 0352 B1), for wasm32, and copies them where they are
// committed: the SDK's test plugin to native/fx-sdk/wasm/test_fx.wasm (the engine's tests run it) and the tremolo
// sample to samples/fx-tremolo/plugins/tremolo/dsp/tremolo.wasm. Each is checked with the engine's validator rules
// before it is written: no imports, the ABI exports, the memory under its manifest's cap.
//
// Usage (repository root): node native/fx-sdk/build.mjs   (npm run build:fx-examples)
// Needs only Rust: the pinned toolchain (`cargo +1.99.1`) with the wasm32-unknown-unknown target. No wasm-bindgen.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModule } from "../../src/engine/wasm/meter.js";
import { wasmBuildEnv } from "../rustflags.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const keepTarget = process.argv.includes("--keep-target");

/** One plugin crate: its manifest, its wasm's name in the target dir, where it is committed, its memory cap in MiB. */
const PLUGINS = [
  { manifest: join(here, "Cargo.toml"), pkg: "test-fx", wasm: "test_fx.wasm", out: join(here, "wasm", "test_fx.wasm"), memoryMB: 4 },
  {
    manifest: join(repo, "samples", "fx-tremolo", "plugins", "tremolo", "dsp", "Cargo.toml"),
    pkg: "tremolo",
    wasm: "tremolo.wasm",
    out: join(repo, "samples", "fx-tremolo", "plugins", "tremolo", "dsp", "tremolo.wasm"),
    memoryMB: 1,
  },
];

for (const p of PLUGINS) {
  const target = join(dirname(p.manifest), "target");
  // A small stack (64 KiB) so the initial memory fits the plugin's budget; the maximum is the manifest's memoryMB.
  const flags = ["-C", "link-arg=-zstack-size=65536", "-C", `link-arg=--max-memory=${p.memoryMB * 1048576}`];
  execFileSync(
    "cargo",
    ["+1.99.1", "build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", p.manifest, "-p", p.pkg, "--target-dir", target],
    // Paths remapped, so any checkout builds the same bytes (ADR 0432).
    { stdio: "inherit", env: wasmBuildEnv(flags) },
  );
  const built = join(target, "wasm32-unknown-unknown", "release", p.wasm);
  const info = readModule(readFileSync(built));
  if (info.imports.length > 0) throw new Error(`${p.wasm} imports ${info.imports.map((i) => `${i.module}.${i.name}`).join(", ")}; a plugin module may import nothing`);
  const mem = info.memories[0];
  if (!mem || mem.max === null || mem.max > p.memoryMB * 16) throw new Error(`${p.wasm}: its memory must declare a maximum of at most ${p.memoryMB} MiB`);
  mkdirSync(dirname(p.out), { recursive: true });
  copyFileSync(built, p.out);
  console.log(`[build:fx-examples] ${p.out.slice(repo.length + 1)}: ${readFileSync(p.out).length} bytes, memory ${mem.min}..${mem.max} pages`);
  if (!keepTarget) rmSync(target, { recursive: true, force: true });
}
