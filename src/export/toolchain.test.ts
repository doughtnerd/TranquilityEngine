import { describe, expect, it } from "vitest";
import { assessToolchain, foundTools, type ToolchainProbe } from "./toolchain";

// ADR 0406: what the desktop editor's toolchain probe means for building a desktop package.
const FULL: ToolchainProbe = {
  os: "windows",
  cargo: "cargo 1.90.0",
  rustc: "rustc 1.90.0",
  cmake: "cmake version 3.30.0",
  cCompiler: "Visual Studio Build Tools 2022 (MSVC)",
  cargoTauri: null,
  npx: "10.9.0",
};

describe("assessToolchain", () => {
  it("is ready with everything, preferring cargo tauri over npx", () => {
    expect(assessToolchain(FULL)).toEqual({ ready: true, cli: "npx" });
    expect(assessToolchain({ ...FULL, cargoTauri: "tauri-cli 2.9.0" })).toEqual({ ready: true, cli: "cargo-tauri" });
  });

  it("lists every missing tool, with where to get it", () => {
    const result = assessToolchain({ ...FULL, cargo: null, cmake: null, npx: null });
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.missing.map((m) => m.name)).toEqual(["Rust", "CMake", "The Tauri CLI"]);
    expect(result.missing[0].url).toBe("https://rustup.rs");
  });

  it("names the platform's C compiler", () => {
    const name = (os: ToolchainProbe["os"]) => {
      const r = assessToolchain({ ...FULL, os, cCompiler: null });
      return r.ready ? null : r.missing[0].name;
    };
    expect(name("windows")).toBe("Microsoft C++ Build Tools");
    expect(name("macos")).toBe("Xcode command line tools");
    expect(name("linux")).toBe("A C compiler");
  });

  it("an empty probe misses everything", () => {
    const result = assessToolchain({ os: "linux", cargo: null, rustc: null, cmake: null, cCompiler: null, cargoTauri: null, npx: null });
    expect(result.ready ? [] : result.missing).toHaveLength(4);
  });
});

describe("foundTools", () => {
  it("lists what was found, and which CLI runs", () => {
    expect(foundTools(FULL)).toEqual(["Rust: cargo 1.90.0", "C compiler: Visual Studio Build Tools 2022 (MSVC)", "CMake: cmake version 3.30.0", "Tauri CLI: npx @tauri-apps/cli@2 (npx 10.9.0)"]);
    expect(foundTools({ ...FULL, cmake: null })).not.toContainEqual(expect.stringMatching(/^CMake/));
  });
});
