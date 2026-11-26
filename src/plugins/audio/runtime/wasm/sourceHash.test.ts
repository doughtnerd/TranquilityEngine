// ADR 0157 (api-and-models §5): the committed myco_audio.wasm must match its Rust sources. This test
// recomputes the source hash of native/audio/ with node:crypto, by the rule in
// native/audio/crates/audio-wasm/source_hash.rs, and compares it with wasm/hash.json and with the
// hash the wasm embeds. Skipped when native/audio is absent (an exported project, a package).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeAudio = fileURLToPath(new URL("../../../../../native/audio/", import.meta.url));
const wasmDir = fileURLToPath(new URL("./", import.meta.url));
const hashFile = join(wasmDir, "hash.json");
const wasmFile = join(wasmDir, "myco_audio.wasm");
const REBUILD = "run `npm run build:audio`";

/** Directories never descended into, at any depth. */
export const SKIPPED_DIRS = ["target", "vectors", "tests"] as const;
/** File names hashed besides `*.rs`. */
export const HASHED_NAMES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"] as const;
/** The crates under `../common/` the audio core links, so hashes (`SHARED_CRATES` in source_hash.rs). */
export const SHARED_CRATES = ["curve"] as const;
/** The digest of the fixture both this test and audio-wasm's tests/source_hash.rs check. */
export const FIXTURE_HASH = "f4f9ef03a71eeb91422df242049a55bb";

/** The hashed files under `root` as `[key, absolutePath]`, sorted by key in ascending byte order. */
export function hashedFiles(root: string): [string, string][] {
  const out: [string, string][] = [];
  const skipped: readonly string[] = SKIPPED_DIRS;
  const hashedNames: readonly string[] = HASHED_NAMES;
  const walk = (dir: string, prefix: string): void => {
    // withFileTypes reports symlinks as symlinks, so they are neither followed nor hashed.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.includes(entry.name)) walk(path, key);
      } else if (entry.isFile() && (entry.name.endsWith(".rs") || hashedNames.includes(entry.name))) {
        out.push([key, path]);
      }
    }
  };
  walk(root, "");
  // The shared crates the core links (ADR 0370, 0420): `../common/<crate>/`, keyed under it, with the same skips.
  for (const krate of SHARED_CRATES) {
    const dir = join(root, "..", "common", krate);
    if (existsSync(dir)) walk(dir, `../common/${krate}`);
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

/** The source hash of `root` as 32 lowercase hex digits. */
export function sourceHash(root: string): string {
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

/** A fresh directory under the system temp dir (node:os is not used, so the env vars stand in). */
function tempDir(): string {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return mkdtempSync(join(base, "myco-source-hash-"));
}

/** Runs `body` on the spec's fixture, in a temp dir removed afterwards. */
function withFixture(body: (root: string) => void, options: { lf?: boolean } = {}): void {
  const base = tempDir();
  // The hashed root is `base/core`, so `root/../common` is the fixture's own shared crates.
  const root = join(base, "core");
  try {
    const fix = (s: string) => (options.lf ? s.replace(/\r\n/g, "\n") : s);
    const files: [string, string][] = [
      ["Cargo.toml", fix("[workspace]\r\nmembers = [\"crates/*\"]\r\n")],
      ["rust-toolchain.toml", "[toolchain]\nchannel = \"1.99.1\"\n"],
      ["Cargo.lock", "# lock\n"],
      ["crates/a/Cargo.toml", "[package]\nname = \"a\"\n"],
      ["crates/a/src/lib.rs", fix("pub fn a() {}\r\n")],
      ["crates/b/src/lib.rs", "pub fn b() {}\n"],
      // Left out: skipped directories at any depth, and other file types.
      ["crates/a/tests/t.rs", "fn t() {}\n"],
      ["target/debug/x.rs", "fn x() {}\n"],
      ["vectors/wire.rs", "fn w() {}\n"],
      ["crates/a/README.md", "# a\n"],
      ["build.mjs", "export {};\n"],
      // The shared crates the core links (ADR 0370): hashed under `../common/`, with the same skips; another shared
      // crate beside them (ADR 0420) is left out.
      ["../common/curve/Cargo.toml", '[package]\nname = "c"\n'],
      ["../common/curve/src/lib.rs", fix("pub fn c() {}\r\n")],
      ["../common/curve/target/debug/y.rs", "fn y() {}\n"],
      ["../common/curve/tests/t.rs", "fn t() {}\n"],
      ["../common/other/src/lib.rs", "pub fn o() {}\n"],
    ];
    for (const [rel, contents] of files) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    body(root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const FIXTURE_KEYS = [
  "../common/curve/Cargo.toml",
  "../common/curve/src/lib.rs",
  "Cargo.lock",
  "Cargo.toml",
  "crates/a/Cargo.toml",
  "crates/a/src/lib.rs",
  "crates/b/src/lib.rs",
  "rust-toolchain.toml",
];

describe.skipIf(!existsSync(nativeAudio))("audio core source hash", () => {
  it("hashes the fixture to FIXTURE_HASH", () => {
    withFixture((root) => {
      expect(sourceHash(root)).toBe(FIXTURE_HASH);
    });
  });

  it("leaves out skipped directories and other file types", () => {
    withFixture((root) => {
      expect(hashedFiles(root).map(([key]) => key)).toEqual(FIXTURE_KEYS);
    });
  });

  it("hashes CRLF and LF checkouts the same", () => {
    let crlf = "";
    let lf = "";
    withFixture((root) => {
      crlf = sourceHash(root);
    });
    withFixture(
      (root) => {
        lf = sourceHash(root);
      },
      { lf: true },
    );
    expect(lf).toBe(crlf);
    expect(lf).toBe(FIXTURE_HASH);
  });

  it("matches wasm/hash.json (else: run `npm run build:audio`)", () => {
    if (!existsSync(hashFile)) throw new Error(`wasm/hash.json is missing: ${REBUILD}`);
    const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
    expect(sourceHash(nativeAudio), `wasm/hash.json is stale: ${REBUILD}`).toBe(recorded);
  });

  it("matches the hash myco_audio.wasm embeds", () => {
    if (!existsSync(hashFile) || !existsSync(wasmFile)) {
      throw new Error(`wasm/hash.json or myco_audio.wasm is missing: ${REBUILD}`);
    }
    const recorded = (JSON.parse(readFileSync(hashFile, "utf8")) as { sourceHash: string }).sourceHash;
    const memory = new WebAssembly.Memory({ initial: 64 });
    const module = new WebAssembly.Module(readFileSync(wasmFile));
    // ABI 5.0 (ADR 0352): the core imports `myco_ext` (plugin effects); none runs here.
    const myco_ext = { acquire: () => 0, release: () => {}, describe: () => 0, process: () => -1, sweep: () => {} };
    const instance = new WebAssembly.Instance(module, { env: { memory }, myco_ext });
    const pointer = (instance.exports.myco_audio_source_hash as () => number)();
    const embedded = Buffer.from(new Uint8Array(memory.buffer, pointer, 16)).toString("hex");
    expect(embedded, `myco_audio.wasm embeds a stale hash: ${REBUILD}`).toBe(recorded);
  });
});
