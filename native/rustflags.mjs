// Reproducible wasm builds (ADR 0428): every native build script (except native/nav, frozen) compiles its wasm with
// `--remap-path-prefix` for the repository root (to `/myco`) and CARGO_HOME (to `/cargo`), so the paths rustc writes
// into panic locations (crates outside a workspace, such as native/common, and registry crates) don't name the
// checkout that built it, and through `rustc-wrapper.mjs`, which takes the checkout's path out of the crate identities
// Cargo hands rustc: builds from any checkout or worktree are byte-identical. Imported by the build scripts only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, with no trailing separator. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");

/** Where Cargo keeps the registry's sources: CARGO_HOME, else `~/.cargo`. */
export const CARGO_HOME = (process.env.CARGO_HOME ?? join(homedir(), ".cargo")).replace(/[\\/]+$/, "");

/** The remapping flags: the repository root to `/myco`, CARGO_HOME to `/cargo`. */
export const REMAP_FLAGS = Object.freeze([`--remap-path-prefix=${REPO_ROOT}=/myco`, `--remap-path-prefix=${CARGO_HOME}=/cargo`]);

/**
 * The wasm32 rustflags a workspace's `.cargo/config.toml` sets (`[target.wasm32-unknown-unknown] rustflags = [...]`),
 * or none. CARGO_ENCODED_RUSTFLAGS replaces the config's flags, so a build passing it passes these too, keeping the
 * config the one place they're written (a plain `cargo build --target wasm32-unknown-unknown` uses them).
 */
export function configRustflags(workspace) {
  let text;
  try {
    text = readFileSync(join(workspace, ".cargo", "config.toml"), "utf8");
  } catch {
    return [];
  }
  const section = /^\[target\.wasm32-unknown-unknown\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const flags = /^\s*rustflags\s*=\s*(\[[^\]]*\])/m.exec(section)?.[1];
  return flags ? JSON.parse(flags) : [];
}

/** Cargo's rustc wrapper that takes the checkout's path out of crates' identities (`rustc-wrapper.mjs` says why). */
export const RUSTC_WRAPPER = fileURLToPath(new URL(process.platform === "win32" ? "./rustc-wrapper.cmd" : "./rustc-wrapper.mjs", import.meta.url));

/**
 * The environment for a cargo wasm build: CARGO_ENCODED_RUSTFLAGS holding `flags` and the remapping (unit-separated,
 * so a path with spaces stays one argument; it takes precedence over RUSTFLAGS and every config's rustflags, which are
 * removed so nothing else applies), and RUSTC_WRAPPER set to `rustc-wrapper.mjs` (replacing any other wrapper, such
 * as a compiler cache, for these builds).
 */
export function wasmBuildEnv(flags = [], base = process.env) {
  const env = { ...base, CARGO_ENCODED_RUSTFLAGS: [...flags, ...REMAP_FLAGS].join("\x1f"), RUSTC_WRAPPER };
  delete env.RUSTC_WORKSPACE_WRAPPER;
  delete env.RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS;
  delete env.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS;
  return env;
}
