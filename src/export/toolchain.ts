// The host toolchain a desktop package needs (ADR 0406): what the desktop editor's probe
// (src-tauri/src/game_build.rs, `myco_build_toolchain`) found, read into whether the editor can
// build the app itself, which Tauri CLI it runs, and what to install when it can't. No process
// access here: the editor asks the shell, this decides.

/** What the host has: each tool's version line, or null when it isn't installed. */
export interface ToolchainProbe {
  readonly os: "windows" | "macos" | "linux";
  readonly cargo: string | null;
  readonly rustc: string | null;
  readonly cmake: string | null;
  /** MSVC Build Tools on Windows, the Xcode command line tools on macOS, `cc` on Linux. */
  readonly cCompiler: string | null;
  /** `cargo tauri` (`cargo install tauri-cli`). */
  readonly cargoTauri: string | null;
  /** npx, which runs `@tauri-apps/cli` without installing it. */
  readonly npx: string | null;
}

/** How the editor runs the Tauri CLI: `cargo tauri`, else `npx @tauri-apps/cli@2`. */
export type TauriCli = "cargo-tauri" | "npx";

/** One thing to install. */
export interface MissingTool {
  readonly name: string;
  /** What it's for and how to get it, in a sentence. */
  readonly how: string;
  readonly url: string;
}

export type ToolchainReadiness = { readonly ready: true; readonly cli: TauriCli } | { readonly ready: false; readonly missing: readonly MissingTool[] };

const C_COMPILER: Record<ToolchainProbe["os"], MissingTool> = {
  windows: { name: "Microsoft C++ Build Tools", how: "Rust links with them on Windows: install the \"Desktop development with C++\" workload.", url: "https://visualstudio.microsoft.com/visual-cpp-build-tools/" },
  macos: { name: "Xcode command line tools", how: "Rust links with them on macOS: run xcode-select --install.", url: "https://tauri.app/start/prerequisites/#macos" },
  linux: { name: "A C compiler", how: "Rust and SDL3 compile with it, plus Tauri's WebKitGTK libraries.", url: "https://tauri.app/start/prerequisites/#linux" },
};

/** Whether `probe` can build a desktop package, and with which CLI; else everything missing. */
export function assessToolchain(probe: ToolchainProbe): ToolchainReadiness {
  const missing: MissingTool[] = [];
  if (!probe.cargo || !probe.rustc) missing.push({ name: "Rust", how: "It compiles the app: install it with rustup.", url: "https://rustup.rs" });
  if (!probe.cCompiler) missing.push(C_COMPILER[probe.os]);
  if (!probe.cmake) missing.push({ name: "CMake", how: "Gamepad support builds SDL3 from source with it.", url: "https://cmake.org/download/" });
  const cli: TauriCli | null = probe.cargoTauri ? "cargo-tauri" : probe.npx ? "npx" : null;
  if (!cli) missing.push({ name: "The Tauri CLI", how: "It packages the app: install Node.js (the editor runs it with npx), or run cargo install tauri-cli.", url: "https://nodejs.org" });
  return cli && missing.length === 0 ? { ready: true, cli } : { ready: false, missing };
}

/** One line per tool the probe found, for the dialog: "Rust: cargo 1.90.0 …". */
export function foundTools(probe: ToolchainProbe): string[] {
  const lines: [string, string | null][] = [
    ["Rust", probe.cargo],
    ["C compiler", probe.cCompiler],
    ["CMake", probe.cmake],
    ["Tauri CLI", probe.cargoTauri ? `cargo tauri (${probe.cargoTauri})` : probe.npx ? `npx @tauri-apps/cli@2 (npx ${probe.npx})` : null],
  ];
  return lines.filter((l): l is [string, string] => l[1] !== null).map(([name, version]) => `${name}: ${version}`);
}
