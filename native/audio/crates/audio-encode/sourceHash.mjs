// The encoder's own source hash (ADR 0351 A2), the rule in this crate's build.rs, which embeds it in the wasm.
// `native/audio/build.mjs` uses it to tell whether the committed myco_audio_encode.wasm is older than its sources when
// wasi-sdk isn't installed; `src/export/audioEncoder.test.ts` checks the committed wasm against it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The vendored C libraries the encoder compiles, under `native/audio/third_party/`. */
export const ENCODER_LIBRARIES = ["libogg", "libvorbis", "opus"];

function collect(dir, key, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const k = `${key}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "target" && e.name !== "tests") collect(join(dir, e.name), k, out);
    } else if (e.isFile()) {
      out.push([k, join(dir, e.name)]);
    }
  }
}

/** The hash (32 lowercase hex digits) of the encoder's sources under `root` (`native/audio/`). */
export function encoderSourceHash(root) {
  const files = [];
  collect(join(root, "crates/audio-encode"), "crates/audio-encode", files);
  for (const lib of ENCODER_LIBRARIES) collect(join(root, "third_party", lib), `third_party/${lib}`, files);
  files.push(["rust-toolchain.toml", join(root, "rust-toolchain.toml")]);
  files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const h = createHash("sha256");
  const len = Buffer.alloc(8);
  for (const [key, path] of files) {
    const raw = readFileSync(path);
    const text = Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
    len.writeBigUInt64LE(BigInt(text.length));
    h.update(Buffer.from(key, "utf8"));
    h.update(Buffer.from([0]));
    h.update(len);
    h.update(text);
  }
  return h.digest("hex").slice(0, 32);
}
