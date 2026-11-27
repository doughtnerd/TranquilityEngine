#!/usr/bin/env node
// Cargo's rustc wrapper for reproducible wasm builds (ADR 0432), set as RUSTC_WRAPPER by ../native/rustflags.mjs's
// `wasmBuildEnv`. Cargo names each crate instance with `-C metadata=<hash>`, and for a path dependency outside the
// workspace (native/common/* from native/anim, native/tween and native/audio) that hash covers the dependency's
// absolute path. rustc derives the crate's identity from it, and the order it lays out code and data follows that
// identity, so the same sources built in two checkouts gave different bytes even with every path remapped.
//
// The wrapper replaces the metadata value with a hash of what defines the crate instance with the checkout's paths
// taken out: its arguments (crate name, source file, edition, features and cfgs, codegen flags) with the repository
// root and CARGO_HOME remapped as `--remap-path-prefix` remaps them, and each `--extern` dependency by the value this
// wrapper gave it (kept beside the dependency's output, `.myco-meta-<file stem>`, written before rustc runs). Output file names (`-C
// extra-filename`) stay Cargo's, so Cargo finds its outputs; only what rustc hashes into the crate changes. Calls
// without `-C metadata` (Cargo's probes: `-vV`, `--print`) pass through untouched.
//
// Usage (by Cargo): rustc-wrapper.mjs <rustc> <args...>. Windows runs rustc-wrapper.cmd beside it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CARGO_HOME, REPO_ROOT } from "./rustflags.mjs";

const [rustc, ...args] = process.argv.slice(2);

/** The value of codegen option `name` (`-C name=v` or `-Cname=v`) at `i`, or null. */
function codegenValue(i, name) {
  const a = args[i];
  if (a === "-C" && args[i + 1]?.startsWith(`${name}=`)) return { value: args[i + 1].slice(name.length + 1), width: 2 };
  if (a.startsWith(`-C${name}=`)) return { value: a.slice(name.length + 3), width: 1 };
  return null;
}

/** `text` with the checkout's paths replaced, as `--remap-path-prefix` replaces them (either separator on Windows). */
function remapped(text) {
  let out = text;
  for (const [from, to] of [
    [REPO_ROOT, "/myco"],
    [CARGO_HOME, "/cargo"],
  ]) {
    out = out.split(from).join(to);
    if (from.includes("\\")) out = out.split(from.replace(/\\/g, "/")).join(to);
  }
  return out;
}

/** Where this wrapper keeps the metadata it gave the crate whose output is `file` (`libname-hash.rlib`, `name-hash.dll`). */
const metaFileOf = (file) => join(dirname(file), `.myco-meta-${basename(file).replace(/^lib/, "").replace(/\.[^.]+$/, "")}`);

let metadataAt = -1;
let crateName = null;
let outDir = null;
let extraFilename = "";
const identity = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const metadata = codegenValue(i, "metadata");
  if (metadata) {
    metadataAt = i + metadata.width - 1;
    i += metadata.width - 1;
    continue;
  }
  const extra = codegenValue(i, "extra-filename");
  if (extra) {
    extraFilename = extra.value;
    i += extra.width - 1;
    continue;
  }
  if (a === "--crate-name") crateName = args[i + 1];
  if (a === "--out-dir") {
    outDir = args[++i];
    continue;
  }
  // Search paths say where to look, not what the crate is (a build script's OUT_DIR names Cargo's own hashes).
  if (a === "-L") {
    i++;
    continue;
  }
  if (a.startsWith("-L")) continue;
  if (a === "--extern") {
    const spec = args[++i];
    const eq = spec.indexOf("=");
    if (eq < 0) identity.push("--extern", spec);
    else {
      let dep;
      try {
        dep = readFileSync(metaFileOf(spec.slice(eq + 1)), "utf8").trim();
      } catch {
        dep = remapped(basename(spec.slice(eq + 1))); // not built through this wrapper
      }
      identity.push("--extern", `${spec.slice(0, eq)}=${dep}`);
    }
    continue;
  }
  identity.push(remapped(a));
}

if (metadataAt >= 0 && crateName) {
  const metadata = createHash("sha256").update(identity.join("\0")).digest("hex").slice(0, 16);
  if (args[metadataAt].startsWith("-C")) args[metadataAt] = `-Cmetadata=${metadata}`;
  else args[metadataAt] = `metadata=${metadata}`;
  // Written before rustc runs: Cargo starts dependents as soon as this crate's metadata file is out (pipelining).
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `.myco-meta-${crateName}${extraFilename}`), `${metadata}\n`);
  }
}
// rustc shares Cargo's jobserver through the descriptors CARGO_MAKEFLAGS names (`--jobserver-auth=3,4`): pass them on.
const jobserverFds = (/--jobserver-(?:auth|fds)=(\d+),(\d+)/.exec(process.env.CARGO_MAKEFLAGS ?? "") ?? []).slice(1).map(Number);
const stdio = ["inherit", "inherit", "inherit"];
for (const fd of jobserverFds) stdio[fd] = fd;
for (let i = 3; i < stdio.length; i++) stdio[i] ??= "ignore";
const result = spawnSync(rustc, args, { stdio });
process.exit(result.status ?? 1);
