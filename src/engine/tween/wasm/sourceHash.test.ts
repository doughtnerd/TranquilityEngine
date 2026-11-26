// ADR 0420 (as 0370 for the animation core): the committed myco_tween_bg.wasm must match its Rust sources. This test
// recomputes the source hash of the crates the standalone tween module compiles with node:crypto, by the rule in
// native/tween/source_hash.rs, and compares it with wasm/hash.json and with the hash the wasm embeds (read through its
// glue's `source_hash`). Skipped when native/tween is absent (an exported project, a package).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initSync, source_hash } from "./myco_tween.js";

const native = fileURLToPath(new URL("../../../../native/", import.meta.url));
const wasmDir = fileURLToPath(new URL("./", import.meta.url));
const hashFile = join(wasmDir, "hash.json");
const wasmFile = join(wasmDir, "myco_tween_bg.wasm");
const REBUILD = "run `npm run build:tween` (node native/tween/build.mjs)";

/** The directories hashed, relative to `native/`. */
const HASHED_DIRS: readonly string[] = ["anim/crates/anim-math", "anim/crates/anim-wire", "common/curve", "common/tween", "common/wire", "tween"];
/** Single files hashed, relative to `native/`. */
const HASHED_FILES: readonly string[] = ["anim/Cargo.toml"];
/** Directories never descended into, at any depth. */
const SKIPPED_DIRS: readonly string[] = ["target", "vectors", "tests", "pkg"];
/** File names hashed besides `*.rs`. */
const HASHED_NAMES: readonly string[] = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "config.toml"];
/** The digest of the fixture both this test and native/tween's tests/source_hash.rs check. */
const FIXTURE_HASH = "8823470c885e8f27144416f2587201de";

/** The hashed files under `base` as `[key, absolutePath]`, sorted by key in ascending byte order. */
function hashedFiles(base: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    // withFileTypes reports symlinks as symlinks, so they are neither followed nor hashed.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) walk(path, key);
      } else if (entry.isFile() && (entry.name.endsWith(".rs") || HASHED_NAMES.includes(entry.name))) {
        out.push([key, path]);
      }
    }
  };
  for (const dir of HASHED_DIRS) walk(join(base, dir), dir);
  for (const file of HASHED_FILES) {
    const path = join(base, file);
    if (existsSync(path) && lstatSync(path).isFile()) out.push([file, path]);
  }
  return out.sort((a, b) => Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")));
}

/** `contents` with every `\r\n` replaced by `\n`, byte for byte as the Rust side does it. */
function normalise(contents: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < contents.length - 1; i++) {
    if (contents[i] === 0x0d && contents[i + 1] === 0x0a) {
      parts.push(contents.subarray(start, i), Buffer.from([0x0a]));
      i++;
      start = i + 1;
    }
  }
  parts.push(contents.subarray(start));
  return Buffer.concat(parts);
}

/** The source hash of `base` as 32 lowercase hex digits. */
function sourceHash(base: string): string {
  const hash = createHash("sha256");
  for (const [key, path] of hashedFiles(base)) {
    const contents = normalise(readFileSync(path));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(contents.length));
    hash.update(Buffer.from(key, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(contents);
  }
  return hash.digest().subarray(0, 16).toString("hex");
}

/** Runs `body` on the fixture (the same files as native/tween's tests/source_hash.rs), in a temp dir removed afterwards. */
function withFixture(body: (base: string) => void, options: { lf?: boolean } = {}): void {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  const base = mkdtempSync(join(tmp, "myco-tween-source-hash-"));
  try {
    const fix = (s: string) => (options.lf ? s.replace(/\r\n/g, "\n") : s);
    const files: [string, string][] = [
      ["tween/src/lib.rs", fix("pub fn t() {}\r\n")],
      ["tween/Cargo.lock", "# lock\n"],
      ["tween/.cargo/config.toml", "[target.wasm32-unknown-unknown]\n"],
      ["common/curve/src/lib.rs", "pub fn c() {}\n"],
      ["anim/Cargo.toml", fix("[workspace]\r\n")],
      ["anim/crates/anim-math/src/lib.rs", "pub fn m() {}\n"],
      ["anim/crates/anim-wire/Cargo.toml", '[package]\nname = "w"\n'],
      // Left out: skipped directories, other file types, and what isn't hashed at all.
      ["tween/target/debug/x.rs", "fn x() {}\n"],
      ["tween/pkg/y.rs", "fn y() {}\n"],
      ["tween/tests/t.rs", "fn t() {}\n"],
      ["tween/build.mjs", "export {};\n"],
      ["anim/crates/anim-wire/vectors/v.rs", "fn v() {}\n"],
      ["anim/crates/anim-wasm/src/lib.rs", "fn a() {}\n"],
      ["anim/Cargo.lock", "# not hashed\n"],
      ["audio/src/lib.rs", "fn a() {}\n"],
    ];
    for (const [rel, contents] of files) {
      const path = join(base, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    body(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(join(native, "tween")))("standalone tween module source hash", () => {
  it("hashes the fixture to the digest Rust computes, CRLF or LF", () => {
    withFixture((base) => {
      expect(hashedFiles(base).map(([key]) => key)).toEqual([
        "anim/Cargo.toml",
        "anim/crates/anim-math/src/lib.rs",
        "anim/crates/anim-wire/Cargo.toml",
        "common/curve/src/lib.rs",
        "tween/.cargo/config.toml",
        "tween/Cargo.lock",
        "tween/src/lib.rs",
      ]);
      expect(sourceHash(base)).toBe(FIXTURE_HASH);
    });
    withFixture((base) => expect(sourceHash(base)).toBe(FIXTURE_HASH), { lf: true });
  });

  it(`matches wasm/hash.json (else: ${REBUILD})`, () => {
    if (!existsSync(hashFile)) throw new Error(`wasm/hash.json is missing: ${REBUILD}`);
    const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
    expect(sourceHash(native), `wasm/hash.json is stale: ${REBUILD}`).toBe(recorded);
  });

  it("matches the hash myco_tween_bg.wasm embeds", () => {
    if (!existsSync(hashFile) || !existsSync(wasmFile)) throw new Error(`wasm/hash.json or myco_tween_bg.wasm is missing: ${REBUILD}`);
    const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
    initSync({ module: readFileSync(wasmFile) });
    expect(source_hash(), `myco_tween_bg.wasm embeds a stale hash: ${REBUILD}`).toBe(recorded);
  });
});
