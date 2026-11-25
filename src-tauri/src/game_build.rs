//! Desktop game builds from the editor (ADR 0406): the host's toolchain, probed, and the Tauri
//! CLI run in a desktop package the editor has written (ADR 0041's `<out>/web/` + `<out>/src-tauri/`).
//!
//! `myco_build_toolchain` reports what the host has (each tool's version line, or none); the page
//! decides what's missing (src/export/toolchain.ts). `myco_build_desktop_app` runs one step of the
//! build, `icon` or `build`, with the Tauri CLI the page chose (`cargo tauri` or `npx
//! @tauri-apps/cli@2`), streaming its output lines to the page and resolving to the exit code. It
//! runs nothing else: no program or arguments come from the page, and the folder must hold a
//! generated `src-tauri/tauri.conf.json`.
//!
//! The editor runs as a GUI app, which on macOS doesn't get the shell's PATH, so both look in the
//! usual install folders too (`~/.cargo/bin`, Homebrew's) after PATH. On Windows its environment
//! can be stale or someone else's (an MSI starts the app with its installer's), so both run tools
//! in the user's environment read fresh from their account (`user_environment`).
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::ipc::Channel;

/// What the host has: each tool's first version line, or `None` when it isn't installed or fails.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainProbe {
    /// `windows`, `macos` or `linux`.
    pub os: &'static str,
    pub cargo: Option<String>,
    pub rustc: Option<String>,
    /// SDL3, which gamepads use (ADR 0335), builds from source with CMake.
    pub cmake: Option<String>,
    /// A C/C++ compiler and linker: MSVC Build Tools on Windows (found by vswhere), the Xcode
    /// command line tools on macOS, `cc` on Linux.
    pub c_compiler: Option<String>,
    /// The Tauri CLI as a cargo subcommand (`cargo install tauri-cli`).
    pub cargo_tauri: Option<String>,
    /// npx (Node.js), which runs `@tauri-apps/cli` without installing it.
    pub npx: Option<String>,
}

/// Probes the host's toolchain. Async so the probes (a few process launches) run off the main thread.
#[tauri::command]
pub async fn myco_build_toolchain() -> ToolchainProbe {
    tauri::async_runtime::spawn_blocking(probe)
        .await
        .unwrap_or_default()
}

/// Runs `step` (`icon` or `build`) of the desktop package in `dir` with `cli` (`cargo-tauri` or
/// `npx`), sending each output line to `on_output`; resolves to the exit code.
#[tauri::command]
pub async fn myco_build_desktop_app(
    dir: String,
    cli: String,
    step: String,
    on_output: Channel<String>,
) -> Result<i32, String> {
    let dir = PathBuf::from(dir);
    if !dir.join("src-tauri").join("tauri.conf.json").is_file() {
        return Err(format!(
            "{} doesn't hold a desktop package (src-tauri/tauri.conf.json).",
            dir.display()
        ));
    }
    let (program, args) = command_line(&dir, &cli, &step)?;
    tauri::async_runtime::spawn_blocking(move || run(&dir, &program, &args, &on_output))
        .await
        .map_err(|e| e.to_string())?
}

const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

/// The npm package the `npx` CLI runs: Tauri v2, the version the generated project is written for.
const TAURI_CLI_PACKAGE: &str = "@tauri-apps/cli@2";

fn probe() -> ToolchainProbe {
    ToolchainProbe {
        os: OS,
        cargo: version("cargo", &["--version"]),
        rustc: version("rustc", &["--version"]),
        cmake: version("cmake", &["--version"]),
        c_compiler: c_compiler(),
        cargo_tauri: version("cargo", &["tauri", "--version"]),
        npx: version(npx(), &["--version"]),
    }
}

/// npx is a batch file on Windows, which `Command` finds only by its full name.
fn npx() -> &'static str {
    if cfg!(windows) { "npx.cmd" } else { "npx" }
}

/// The program and arguments for one step. Only these two steps, with fixed arguments.
fn command_line(dir: &Path, cli: &str, step: &str) -> Result<(String, Vec<String>), String> {
    let (program, mut args): (&str, Vec<String>) = match cli {
        "cargo-tauri" => ("cargo", vec!["tauri".into()]),
        "npx" => (npx(), vec!["--yes".into(), TAURI_CLI_PACKAGE.into()]),
        other => return Err(format!("unknown Tauri CLI \"{other}\"")),
    };
    match step {
        "icon" => {
            let source = ["app-icon.png", "app-icon.svg"]
                .iter()
                .map(|name| dir.join("src-tauri").join(name))
                .find(|p| p.is_file())
                .ok_or("src-tauri/app-icon.png or app-icon.svg is missing")?;
            args.push("icon".into());
            args.push(source.to_string_lossy().into_owned());
            args.push("--output".into());
            args.push(dir.join("src-tauri").join("icons").to_string_lossy().into_owned());
        }
        "build" => args.push("build".into()),
        other => return Err(format!("unknown build step \"{other}\"")),
    }
    Ok((program.into(), args))
}

/// The user's environment as a program they start now would get it (Windows): the variables in
/// the registry for their account, read fresh from the process's token. The editor's own may be
/// someone else's: an MSI started at the end of an install inherits the installer's custom-action
/// process's (no user PATH, so no `~/.cargo/bin`, and the wrong USERPROFILE, so rustup finds no
/// toolchain), and any editor keeps the PATH it started with after the user installs a tool.
/// Empty elsewhere, and when Windows can't build it: the editor's own then stands.
#[cfg(windows)]
fn user_environment() -> Vec<(OsString, OsString)> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStringExt;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    }
    #[link(name = "userenv")]
    unsafe extern "system" {
        fn CreateEnvironmentBlock(block: *mut *mut c_void, token: Handle, inherit: i32) -> i32;
        fn DestroyEnvironmentBlock(block: *mut c_void) -> i32;
    }
    const TOKEN_DUPLICATE: u32 = 0x2;
    const TOKEN_IMPERSONATE: u32 = 0x4;
    const TOKEN_QUERY: u32 = 0x8;
    let mut vars = Vec::new();
    // SAFETY: the token is closed and the block destroyed on every path; the block is a run of
    // NUL-terminated UTF-16 "NAME=value" strings ended by an empty one, read up to that end.
    unsafe {
        let mut token: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token) == 0 {
            return vars;
        }
        let mut block: *mut c_void = std::ptr::null_mut();
        let made = CreateEnvironmentBlock(&mut block, token, 0) != 0;
        CloseHandle(token);
        if !made || block.is_null() {
            return vars;
        }
        let mut at = block as *const u16;
        loop {
            let mut len = 0;
            while *at.add(len) != 0 {
                len += 1;
            }
            if len == 0 {
                break;
            }
            let entry = std::slice::from_raw_parts(at, len);
            // Names may not hold '=', but hidden per-drive entries ("=C:=C:\…") start with one.
            if let Some(eq) = entry.iter().skip(1).position(|&c| c == u16::from(b'=')).map(|i| i + 1) {
                vars.push((OsString::from_wide(&entry[..eq]), OsString::from_wide(&entry[eq + 1..])));
            }
            at = at.add(len + 1);
        }
        DestroyEnvironmentBlock(block);
    }
    vars
}

#[cfg(not(windows))]
fn user_environment() -> Vec<(OsString, OsString)> {
    Vec::new()
}

/// `name` in `user_env` (names compared without case, as Windows does), else the editor's own.
fn lookup(user_env: &[(OsString, OsString)], name: &str) -> Option<OsString> {
    user_env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var_os(name))
}

/// The user's PATH, then the editor's, then the folders installers put these tools in, which a
/// GUI app's PATH may lack.
fn search_path(user_env: &[(OsString, OsString)]) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = lookup(user_env, if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let cargo_home = lookup(user_env, "CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".cargo")));
    let paths = [lookup(user_env, "PATH"), std::env::var_os("PATH")];
    let mut found: Vec<PathBuf> = paths.iter().flatten().flat_map(std::env::split_paths).collect();
    found.extend(cargo_home.map(|c| c.join("bin")));
    if cfg!(target_os = "macos") {
        found.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    for dir in found {
        if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    let user_env = user_environment();
    for (name, value) in &user_env {
        if !name.eq_ignore_ascii_case("PATH") {
            command.env(name, value);
        }
    }
    command
        .env("PATH", search_path(&user_env))
        .env("NO_COLOR", "1")
        .env("CARGO_TERM_COLOR", "never")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        // No console window flashing up for each process.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// The first non-empty line `program args` prints when it succeeds.
fn version(program: &str, args: &[&str]) -> Option<String> {
    let out = command(program).args(args).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(String::from)
}

#[cfg(windows)]
fn c_compiler() -> Option<String> {
    // vswhere ships with every Visual Studio installer, Build Tools included, at a fixed place.
    let root = std::env::var_os("ProgramFiles(x86)")?;
    let vswhere = PathBuf::from(root).join("Microsoft Visual Studio/Installer/vswhere.exe");
    let found = version(
        &vswhere.to_string_lossy(),
        &["-latest", "-prerelease", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "displayName"],
    )?;
    Some(format!("{found} (MSVC)"))
}

#[cfg(target_os = "macos")]
fn c_compiler() -> Option<String> {
    version("xcode-select", &["-p"]).map(|p| format!("Xcode command line tools at {p}"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn c_compiler() -> Option<String> {
    version("cc", &["--version"])
}

fn run(dir: &Path, program: &str, args: &[String], on_output: &Channel<String>) -> Result<i32, String> {
    let mut child = command(program)
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start {program}: {e}"))?;
    let stdout = child.stdout.take().map(|s| forward(s, on_output.clone()));
    let stderr = child.stderr.take().map(|s| forward(s, on_output.clone()));
    let status = child.wait().map_err(|e| e.to_string())?;
    for reader in [stdout, stderr].into_iter().flatten() {
        let _ = reader.join();
    }
    Ok(status.code().unwrap_or(-1))
}

/// Sends `stream`'s lines to `on_output` from a thread of its own (cargo writes to stderr, the CLI to both).
fn forward(stream: impl Read + Send + 'static, on_output: Channel<String>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            // Cargo redraws progress with carriage returns; keep the last state of the line.
            let line = line.rsplit('\r').next().unwrap_or_default().to_string();
            if on_output.send(line).is_err() {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("myco-game-build-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        std::fs::write(dir.join("src-tauri").join("app-icon.svg"), "<svg/>").unwrap();
        dir
    }

    #[test]
    fn build_runs_the_chosen_cli() {
        let dir = package();
        let (program, args) = command_line(&dir, "cargo-tauri", "build").unwrap();
        assert_eq!((program.as_str(), args), ("cargo", vec!["tauri".to_string(), "build".into()]));
        let (program, args) = command_line(&dir, "npx", "build").unwrap();
        assert_eq!(program, npx());
        assert_eq!(args, vec!["--yes".to_string(), TAURI_CLI_PACKAGE.into(), "build".into()]);
    }

    #[test]
    fn icon_uses_the_written_source_and_writes_into_icons() {
        let dir = package();
        let (_, args) = command_line(&dir, "npx", "icon").unwrap();
        assert_eq!(args[2], "icon");
        assert!(args[3].ends_with("app-icon.svg"));
        assert_eq!(args[4], "--output");
        assert!(args[5].ends_with("icons"));
    }

    #[test]
    fn anything_else_is_refused() {
        let dir = package();
        assert!(command_line(&dir, "sh", "build").is_err());
        assert!(command_line(&dir, "npx", "dev").is_err());
    }

    #[test]
    fn the_search_path_adds_cargo_bin() {
        let path = search_path(&user_environment());
        assert!(std::env::split_paths(&path).any(|p| p.ends_with(Path::new(".cargo").join("bin")) || std::env::var_os("CARGO_HOME").is_some()));
    }

    #[test]
    fn the_users_path_comes_first_and_their_home_finds_cargo() {
        let user_env = vec![
            (OsString::from("Path"), OsString::from(std::env::join_paths(["/user/tools"]).unwrap())),
            (OsString::from(if cfg!(windows) { "USERPROFILE" } else { "HOME" }), OsString::from("/home/someone")),
            (OsString::from("CARGO_HOME"), OsString::from("/home/someone/.cargo")),
        ];
        let dirs: Vec<PathBuf> = std::env::split_paths(&search_path(&user_env)).collect();
        assert_eq!(dirs[0], PathBuf::from("/user/tools"));
        assert!(dirs.contains(&PathBuf::from("/home/someone/.cargo").join("bin")));
        // The editor's own PATH is kept after the user's.
        if let Some(own) = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).find(|d| !d.as_os_str().is_empty())) {
            assert!(dirs.contains(&own));
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_user_environment_is_read_from_the_account() {
        let user_env = user_environment();
        assert!(lookup(&user_env, "USERPROFILE").is_some());
        assert!(user_env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")));
        assert!(user_env.iter().all(|(k, _)| !k.is_empty() && !k.to_string_lossy().starts_with('=')));
    }
}
