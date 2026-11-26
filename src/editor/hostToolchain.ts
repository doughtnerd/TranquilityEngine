// The host's toolchain, from the desktop editor (ADR 0406): the shell probes it
// (`myco_build_toolchain`, src-tauri/src/game_build.rs) and runs the Tauri CLI in a desktop package
// the editor wrote (`myco_build_desktop_app`). The browser editor has neither: `probeHostToolchain`
// resolves to null there and Build / Export shows the command line instead. Tauri's JS package loads
// lazily, so browser builds and headless tests never load it.
import { isTauri } from "../engine/platform/FileSystem";
import type { TauriCli, ToolchainProbe } from "../export/toolchain";

/** What the host has, or null where the editor can't run programs (a browser). */
export async function probeHostToolchain(): Promise<ToolchainProbe | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolchainProbe>("myco_build_toolchain");
}

/**
 * Build the desktop package in `dir` with the host's toolchain: the app icons (`tauri icon`), then
 * the installers (`tauri build`, in `dir`/src-tauri/target/release/bundle/). `onLine` hears every
 * output line and `onStep` each step as it starts. Throws when a step fails, saying which.
 */
export async function buildDesktopApp(dir: string, cli: TauriCli, onLine: (line: string) => void, onStep?: (step: "icon" | "build") => void): Promise<void> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  for (const step of ["icon", "build"] as const) {
    onStep?.(step);
    const onOutput = new Channel<string>(onLine);
    const code = await invoke<number>("myco_build_desktop_app", { dir, cli, step, onOutput });
    if (code !== 0) throw new Error(step === "icon" ? `Couldn't make the app icons (tauri icon exited with ${code}): build.icon should be a square PNG or SVG.` : `tauri build failed (exit code ${code}): its output is above. The Tauri project is in ${dir}; README.txt there says how to build it by hand.`);
  }
}
