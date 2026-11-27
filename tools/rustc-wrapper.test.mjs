// Tests for native/rustc-wrapper.mjs and native/rustflags.mjs (ADR 0428: reproducible wasm builds).
// Run: node --test tools/rustc-wrapper.test.mjs. The wrapper runs as Cargo runs it, with a stand-in rustc that
// records its arguments.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configRustflags, REMAP_FLAGS, REPO_ROOT, RUSTC_WRAPPER, wasmBuildEnv } from "../native/rustflags.mjs";

const WRAPPER = fileURLToPath(new URL("../native/rustc-wrapper.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rustc-wrapper-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A stand-in rustc: writes its arguments, one per line, to $FAKE_RUSTC_LOG. */
const fakeRustc = join(dir, "rustc.mjs");
writeFileSync(fakeRustc, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FAKE_RUSTC_LOG, process.argv.slice(2).join("\\n"));\n');

/** Runs the wrapper as Cargo would, returning the arguments rustc got. */
function wrap(args) {
  const log = join(dir, "args.txt");
  const r = spawnSync(process.execPath, [WRAPPER, process.execPath, fakeRustc, ...args], { env: { ...process.env, FAKE_RUSTC_LOG: log }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, "utf8").split("\n");
}

const metadataOf = (args) => args.find((a) => a.startsWith("metadata="));

test("replaces Cargo's metadata with one that doesn't depend on where the checkout is", () => {
  const outA = join(dir, "a", "deps");
  const outB = join(dir, "b", "deps");
  mkdirSync(outA, { recursive: true });
  mkdirSync(outB, { recursive: true });
  const crate = (out, cargoHash, src) => ["--crate-name", "myco_curve", "--edition=2021", src, "-C", `metadata=${cargoHash}`, "-C", `extra-filename=-${cargoHash}`, "--out-dir", out, "-L", `dependency=${out}`];
  const a = wrap(crate(outA, "1111", `${REPO_ROOT}/native/common/curve/src/lib.rs`));
  const b = wrap(crate(outB, "2222", `${REPO_ROOT}/native/common/curve/src/lib.rs`));
  assert.match(metadataOf(a), /^metadata=[0-9a-f]{16}$/);
  assert.equal(metadataOf(a), metadataOf(b));
  assert.ok(a.includes("extra-filename=-1111"), "Cargo's output names stay");
  // Each output gets a note of the metadata it was given, which a dependent reads through its --extern.
  assert.equal(readFileSync(join(outA, ".myco-meta-myco_curve-1111"), "utf8").trim(), metadataOf(a).slice("metadata=".length));
  const dependent = (out, hash) => ["--crate-name", "myco_tween", "src/lib.rs", "-C", "metadata=9", "--extern", `myco_curve=${join(out, `libmyco_curve-${hash}.rlib`)}`, "--out-dir", out];
  assert.equal(metadataOf(wrap(dependent(outA, "1111"))), metadataOf(wrap(dependent(outB, "2222"))));
  // A different source is a different crate.
  assert.notEqual(metadataOf(wrap(crate(outA, "1111", `${REPO_ROOT}/native/common/wire/src/lib.rs`))), metadataOf(a));
});

test("passes Cargo's probes through untouched", () => {
  assert.deepEqual(wrap(["-vV"]), ["-vV"]);
  assert.deepEqual(wrap(["-", "--crate-name", "___", "--print=file-names"]), ["-", "--crate-name", "___", "--print=file-names"]);
});

test("a wasm build's environment: the config's flags, the remapping and the wrapper, nothing else", () => {
  const env = wasmBuildEnv(["-C", "target-feature=+simd128"], { RUSTFLAGS: "-C opt-level=0", PATH: "/bin" });
  assert.equal(env.CARGO_ENCODED_RUSTFLAGS, ["-C", "target-feature=+simd128", ...REMAP_FLAGS].join("\x1f"));
  assert.equal(env.RUSTFLAGS, undefined);
  assert.equal(env.RUSTC_WRAPPER, RUSTC_WRAPPER);
  assert.equal(env.PATH, "/bin");
  assert.ok(REMAP_FLAGS[0].endsWith("=/myco") && REMAP_FLAGS[1].endsWith("=/cargo"));
  assert.deepEqual(configRustflags(fileURLToPath(new URL("../native/anim/", import.meta.url))), ["-C", "target-feature=+simd128"]);
  assert.deepEqual(configRustflags(fileURLToPath(new URL("../native/audio/", import.meta.url))), []);
});
