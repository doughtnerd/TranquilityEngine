// Spike B0 (ADR 0352): builds the test plugin and the host stand-in for wasm32 and copies them to ./wasm/.
// Usage (from the repository root): node tools/spikes/fx-plugin/build.mjs
// Needs the audio core's pinned toolchain (`cargo +1.99.1`, target wasm32-unknown-unknown). The plugin's memory is
// capped at 4 MB (the manifest's default `memoryMB`); the host gets the linker's defaults.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const manifest = join(repo, "native", "audio", "spikes", "fx-plugin", "Cargo.toml");
const target = join(repo, "native", "audio", "spikes", "fx-plugin", "target");
const out = join(here, "wasm");
mkdirSync(out, { recursive: true });

function build(pkg, flags) {
  execFileSync(
    "cargo",
    ["+1.99.1", "build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest, "-p", pkg, "--target-dir", target],
    { stdio: "inherit", env: { ...process.env, RUSTFLAGS: flags } },
  );
}

build("fx-plugin", "-C link-arg=--max-memory=4194304 -C link-arg=-zstack-size=65536");
copyFileSync(join(target, "wasm32-unknown-unknown", "release", "fx_plugin.wasm"), join(out, "fx_plugin.wasm"));
build("fx-host", "-C link-arg=-zstack-size=65536");
copyFileSync(join(target, "wasm32-unknown-unknown", "release", "fx_host.wasm"), join(out, "fx_host.wasm"));
console.log("built tools/spikes/fx-plugin/wasm/{fx_plugin,fx_host}.wasm");
