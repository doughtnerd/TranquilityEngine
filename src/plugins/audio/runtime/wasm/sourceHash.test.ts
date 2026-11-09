// ADR 0157 (api-and-models §5): the committed myco_audio.wasm must match its Rust sources. This test
// recomputes the source hash of native/audio/ with node:crypto, by the rule in
// native/audio/crates/audio-wasm/source_hash.rs, and compares it with wasm/hash.json and with the
// hash the wasm embeds. Skipped when native/audio is absent (an exported project, a package).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const nativeAudio = fileURLToPath(new URL("../../../../../native/audio/", import.meta.url));
const wasmDir = fileURLToPath(new URL("./", import.meta.url));

/** Directories never descended into, at any depth. */
export const SKIPPED_DIRS = ["target", "vectors", "tests"] as const;
/** File names hashed besides `*.rs`. */
export const HASHED_NAMES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"] as const;
/** The digest of the fixture both this test and audio-wasm's tests/source_hash.rs check. */
export const FIXTURE_HASH = "f8b235c550292bb3fef841a866a2801f";

/** The hashed files under `root` as `[key, absolutePath]`, sorted by key in ascending byte order. */
export function hashedFiles(root: string): [string, string][] {
  void root;
  throw new Error("not implemented: A0.1-L2");
}

/** The source hash of `root` as 32 lowercase hex digits. */
export function sourceHash(root: string): string {
  void root;
  throw new Error("not implemented: A0.1-L2");
}

void nativeAudio;
void wasmDir;

describe.skipIf(!existsSync(nativeAudio))("audio core source hash", () => {
  it.todo("hashes the fixture to FIXTURE_HASH");
  it.todo("leaves out skipped directories and other file types");
  it.todo("hashes CRLF and LF checkouts the same");
  it.todo("matches wasm/hash.json (else: run `npm run build:audio`)");
  it.todo("matches the hash myco_audio.wasm embeds");
});
