// ADR 0447 (after 0370 and 0157): the committed myco_visibility_bg.wasm and myco_visibility_editor_bg.wasm must match their
// Rust sources. This test recomputes the source hash of native/visibility/ with node:crypto, by the rule in
// native/visibility/crates/vis-wasm/source_hash.rs, and compares it with both hash.json files and with the hash each wasm
// embeds (read through its glue's `source_hash`). Skipped when native/visibility is absent (an exported project, a package).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initSync as initEditor, source_hash as editorSourceHash } from "./editor/myco_visibility_editor.js";
import { initSync, source_hash } from "./myco_visibility.js";

const nativeVisibility = fileURLToPath(new URL("../../../../../../native/visibility/", import.meta.url));
const wasmDir = fileURLToPath(new URL("./", import.meta.url));
const REBUILD = "run `npm run build:visibility` (node native/visibility/build.mjs)";

/** Directories never descended into, at any depth. */
const SKIPPED_DIRS: readonly string[] = ["target", "vectors", "tests"];
/** File names hashed besides `*.rs`. */
const HASHED_NAMES: readonly string[] = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "config.toml"];
/** The digest of the fixture both this test and vis-wasm's tests/source_hash.rs check. */
const FIXTURE_HASH = "95d206ad65c4ab1e5455fbcea1badbf8";

/** The hashed files under `root` as `[key, absolutePath]`, sorted by key in ascending byte order. */
function hashedFiles(root: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    // withFileTypes reports symlinks as symlinks, so they are neither followed nor hashed.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) walk(path, key);
      } else if (entry.isFile() && (entry.name.endsWith(".rs") || HASHED_NAMES.includes(entry.name))) {
        out.push([key, path]);
      }
    }
  };
  walk(root, "");
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

/** The source hash of `root` as 32 lowercase hex digits. */
function sourceHash(root: string): string {
  const hash = createHash("sha256");
  for (const [key, path] of hashedFiles(root)) {
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

/** Runs `body` on the fixture (the same files as vis-wasm's tests/source_hash.rs), in a temp dir removed afterwards. */
function withFixture(body: (root: string) => void, options: { lf?: boolean } = {}): void {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  const root = mkdtempSync(join(base, "myco-vis-source-hash-"));
  try {
    const fix = (s: string) => (options.lf ? s.replace(/\r\n/g, "\n") : s);
    const files: [string, string][] = [
      ["Cargo.toml", fix('[workspace]\r\nmembers = ["crates/*"]\r\n')],
      ["rust-toolchain.toml", '[toolchain]\nchannel = "1.97.0"\n'],
      ["Cargo.lock", "# lock\n"],
      [".cargo/config.toml", "[target.wasm32-unknown-unknown]\n"],
      ["crates/a/Cargo.toml", '[package]\nname = "a"\n'],
      ["crates/a/src/lib.rs", fix("pub fn a() {}\r\n")],
      ["crates/b/src/lib.rs", "pub fn b() {}\n"],
      ["crates/b/benches/b.rs", "fn main() {}\n"],
      // Left out: skipped directories at any depth, and other file types.
      ["crates/a/tests/t.rs", "fn t() {}\n"],
      ["target/debug/x.rs", "fn x() {}\n"],
      ["vectors/core.json", "{}\n"],
      ["crates/a/README.md", "# a\n"],
      ["build.mjs", "export {};\n"],
    ];
    for (const [rel, contents] of files) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const modules = [
  { name: "runtime", dir: wasmDir, wasm: "myco_visibility_bg.wasm", init: initSync, hash: source_hash },
  { name: "editor", dir: join(wasmDir, "editor"), wasm: "myco_visibility_editor_bg.wasm", init: initEditor, hash: editorSourceHash },
];

describe.skipIf(!existsSync(nativeVisibility))("occlusion core source hash", () => {
  it("hashes the fixture to the digest Rust computes", () => {
    withFixture((root) => {
      expect(sourceHash(root)).toBe(FIXTURE_HASH);
    });
  });

  it("leaves out skipped directories and other file types", () => {
    withFixture((root) => {
      expect(hashedFiles(root).map(([key]) => key)).toEqual([
        ".cargo/config.toml",
        "Cargo.lock",
        "Cargo.toml",
        "crates/a/Cargo.toml",
        "crates/a/src/lib.rs",
        "crates/b/benches/b.rs",
        "crates/b/src/lib.rs",
        "rust-toolchain.toml",
      ]);
    });
  });

  it("hashes CRLF and LF checkouts the same", () => {
    let lf = "";
    withFixture(
      (root) => {
        lf = sourceHash(root);
      },
      { lf: true },
    );
    expect(lf).toBe(FIXTURE_HASH);
  });

  for (const m of modules) {
    const hashFile = join(m.dir, "hash.json");
    const wasmFile = join(m.dir, m.wasm);

    it(`matches the ${m.name} module's hash.json (else: ${REBUILD})`, () => {
      if (!existsSync(hashFile)) throw new Error(`${hashFile} is missing: ${REBUILD}`);
      const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
      expect(sourceHash(nativeVisibility), `${m.name} hash.json is stale: ${REBUILD}`).toBe(recorded);
    });

    it(`matches the hash ${m.wasm} embeds`, () => {
      if (!existsSync(hashFile) || !existsSync(wasmFile)) throw new Error(`${hashFile} or ${m.wasm} is missing: ${REBUILD}`);
      const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
      m.init({ module: readFileSync(wasmFile) });
      expect(m.hash(), `${m.wasm} embeds a stale hash: ${REBUILD}`).toBe(recorded);
    });
  }
});
