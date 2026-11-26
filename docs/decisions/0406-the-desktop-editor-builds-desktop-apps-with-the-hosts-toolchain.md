# 0406. The desktop editor builds desktop apps with the host's toolchain

- **Status:** Proposed
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0041, 0296, 0335, 0376, 0403

## Context

ADR 0041 builds desktop games from the command line only: `npm run export -- <dir> --target desktop` writes the web build to `<out>/web/` and a generated Tauri project to `<out>/src-tauri/`, then runs `tauri build` when `cargo` is installed. The editor's Build / Export dialog only shows that command, "since the editor can't run a toolchain", and 0041 left "desktop packages from the editor itself" as an open question.

The command needs a checkout of this repository with its Node dependencies. Someone using the desktop editor on their own project has neither, so in practice they couldn't make a desktop app at all. A Tauri build needs, on the host:

- Rust (`cargo`, `rustc`);
- a C/C++ compiler and linker: MSVC Build Tools on Windows, the Xcode command line tools on macOS, `cc` (plus WebKitGTK's libraries) on Linux;
- CMake, because gamepads (0335) build SDL3 from source;
- the Tauri CLI, as `cargo tauri` (`cargo install tauri-cli`) or the npm package `@tauri-apps/cli`, which `npx` runs without installing.

The desktop editor is a Tauri app, so its Rust shell can launch processes; the browser editor can't.

## Decision

We will let the **desktop editor build desktop apps itself with the host's toolchain**, and say plainly what's missing when the host doesn't have it.

### The shell (`src-tauri/src/game_build.rs`)

- **`myco_build_toolchain`** probes the host and returns each tool's first version line, or null: `cargo`, `rustc`, `cmake`, a C compiler (`vswhere` for MSVC's x64 tools on Windows, `xcode-select -p` on macOS, `cc --version` on Linux), `cargo tauri --version` and `npx --version`, plus the OS. It decides nothing.
- **`myco_build_desktop_app(dir, cli, step, onOutput)`** runs one step in a desktop package the editor wrote: `icon` (`tauri icon src-tauri/app-icon.{png,svg} --output src-tauri/icons`) or `build` (`tauri build`), with `cli` either `cargo-tauri` (`cargo tauri …`) or `npx` (`npx --yes @tauri-apps/cli@2 …`). Output lines stream to the page over a Tauri channel; it resolves to the exit code. **No program or argument comes from the page**: only these two CLIs and two steps, in a folder that must hold `src-tauri/tauri.conf.json`. Processes get no console window on Windows, `NO_COLOR`, and a PATH with `~/.cargo/bin` (or `CARGO_HOME/bin`) and, on macOS, Homebrew's folders appended, since GUI apps on macOS don't inherit the shell's PATH.

### The decision about the probe (`src/export/toolchain.ts`)

`assessToolchain(probe)` is pure: ready, with `cargo-tauri` preferred over `npx`, or the list of missing tools, each with what it's for and where to get it. `foundTools` lists what was found for the dialog.

### Writing the package from the editor (`src/editor/exportBuild.ts`)

`exportDesktopProject` writes 0041's layout through the platform `FileSystem`, with the same build writer (0296): the web build in `web/` for platform `desktop`, keeping `src-tauri/target/` across re-exports; `desktopProjectFiles` into `src-tauri/`, with `gamepad.rs` bundled from `src-tauri/src/gamepad.rs` (`?raw`); the icon's source as `src-tauri/app-icon.png` or `.svg` (`build.icon`, which must be PNG or SVG, else the neutral default); README.txt, rewritten to name the installers once built; and, for a debug build, the debug link's listener crates and the Android multicast plugin under `src-tauri/vendor/` (ADR 0403), bundled into the editor from `native/` with a lazy `import.meta.glob` (the command line reads them from disk).

### The dialog

Opening Build / Export probes the toolchain (`src/editor/hostToolchain.ts`; null in a browser). For **Desktop app**:

- **Toolchain found:** the found tools are listed and **Choose Folder and Build…** writes the package, then runs `icon` and `build`, showing the last 300 output lines. On success the message gives the installers' folder (`src-tauri/target/release/bundle/`) and **Show Folder** opens it.
- **Toolchain missing:** "You don't have the toolchain to build desktop apps on this computer", with each missing tool, what it's for and its URL; **Check Again** probes again, and **Choose Folder and Write Project…** writes the package without building, with the README's instructions.
- **Browser editor:** unchanged, the command line and Copy Command.

The CLI exporter keeps its own `cargo` check and runs `tauri build` from the repo's Tauri CLI as before.

## Alternatives considered

- **Bundle a toolchain with the editor.** Rust, a C toolchain and CMake are gigabytes and platform-specific, and MSVC can't be redistributed. Using what the host has costs nothing and matches what 0041 already asks of CLI users.
- **The shell plugin (`tauri-plugin-shell`) with a scoped command list.** Same effect with more configuration, and a general "run this program" permission in the editor's capability; two fixed commands in Rust are smaller and can't be widened from the page.
- **A generic "run a process" command for the page.** Any script or compromised page could run anything on the user's machine. Refused.
- **Link the Tauri CLI as a Rust crate into the editor.** Adds the whole CLI (bundlers included) to the editor's build and binary for one feature; `cargo tauri` or `npx` already exist wherever developers have Node or cargo.
- **Probe only `cargo`, as the CLI does.** Then a missing CMake or MSVC fails minutes into the build with a long linker error; probing up front gives a clear message first.

## Consequences

**Positive**
- Anyone with the desktop editor and the toolchain can make installers for their game without this repository.
- Without the toolchain, they're told exactly what to install, and can still write the project to build later.
- The shell's surface stays small: two fixed CLIs, two steps, one kind of folder.

**Negative / costs**
- The `npx` route downloads `@tauri-apps/cli@2` on first use (needs a network), and floats on Tauri v2's latest CLI rather than the repo's pinned one.
- The probe can't see everything a build needs (WebKitGTK's development libraries on Linux, a CMake too old for the newest Visual Studio, see the editor guide); those still fail during the build, with the output shown.
- A running build can't be cancelled from the dialog yet; it holds the dialog open until it ends.
- Not run end to end here in a real desktop editor build: the Rust compiles and its unit tests pass, and the TypeScript is unit-tested.

## Deprecates

The desktop option's "built from the command line" text in the desktop editor (kept for the browser editor).

## Open questions

- Cancelling a build (kill the child process from a third command).
- Probing Linux's WebKitGTK libraries (`pkg-config webkit2gtk-4.1`).
- Android packages from the editor (0155) on the same probe.

## References

`src-tauri/src/game_build.rs`, `src-tauri/src/lib.rs`, `src/export/toolchain.ts` (+ test), `src/editor/hostToolchain.ts`, `src/editor/exportBuild.ts` (`exportDesktopProject`, `writeDesktopReadme`; tests in `exportBuild.test.ts`), `src/editor/ui/ExportDialog.tsx`, `src/editor/ui/export.css`.
