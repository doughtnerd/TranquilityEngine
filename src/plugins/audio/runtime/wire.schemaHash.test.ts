// Contract K1: the generated TypeScript must be the one for the current schema. The schema hash is
// SHA-256 (first 16 bytes) over the schema sources of `audio-wire`; this test recomputes it with
// node:crypto, byte for byte as `schema::schema_hash` does in Rust, and compares it with the hash
// embedded in `wire.generated.ts`. A stale file fails with the command that fixes it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_HASH, WIRE_GENERATED } from "./wire.generated";

const crateDir = new URL("../../../../native/audio/crates/audio-wire/", import.meta.url);
// Keep in step with `SCHEMA_SOURCES` in src/schema.rs (a cargo test checks that list is complete).
const SOURCES = ["src/model.rs", "src/schema.rs", "src/schema/batch.rs", "src/schema/envelope.rs", "src/schema/status.rs"];

function schemaHash(): string {
  const h = createHash("sha256");
  for (const path of [...SOURCES].sort()) {
    const text = readFileSync(new URL(path, crateDir), "utf8").replace(/\r\n/g, "\n");
    h.update(Buffer.concat([Buffer.from(path), Buffer.from([0]), Buffer.from(text), Buffer.from([0])]));
  }
  return h.digest("hex").slice(0, 32);
}

describe.skipIf(!existsSync(new URL("src/schema.rs", crateDir)))("wire schema hash", () => {
  it("the generated TypeScript matches the schema sources", () => {
    expect(WIRE_GENERATED).toBe(true);
    expect(SCHEMA_HASH, "wire.generated.ts is stale: run `npm run build:audio`").toBe(schemaHash());
  });
});
