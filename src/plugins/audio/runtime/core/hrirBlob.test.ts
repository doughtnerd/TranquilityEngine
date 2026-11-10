import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSET_BYTES, convert, directionIndex, parseWav, sourceNames } from "../../../../../tools/hrir/convert.mjs";
import { readHrirHeader, resampleHrir } from "./hrir";

// Checks the committed myco_hrir.bin (H5: the header, then the responses as Chromium decodes them, delays in; hrir.ts
// turns it into the wire's format 2, the layout audio-dsp's database.rs enforces).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const BLOB_PATH = join(ROOT, "src/plugins/audio/runtime/wasm/myco_hrir.bin");
const RAW_DIR = join(ROOT, "tools/hrir/raw");

const IR_LENGTH = 256;
const DIRECTIONS = 240;

const blob = readFileSync(BLOB_PATH);
const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
const asset = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;

/** Sample n of the response for direction d, ear, as stored. */
const sampleAt = (d: number, n: number, ear: number) => view.getInt16(16 + ((d * IR_LENGTH + n) * 2 + ear) * 2, true);

describe("myco_hrir.bin", () => {
  it("has exactly the documented byte length (no delay table)", () => {
    expect(ASSET_BYTES).toBe(245_776);
    expect(blob.length).toBe(ASSET_BYTES);
  });

  it("has the 10 x 24 x 256 @ 44100 header", () => {
    expect(readHrirHeader(asset)).toEqual({ elevations: 10, azimuths: 24, irLength: 256, rate: 44100 });
  });

  it("has a peak below full scale", () => {
    let peak = 0;
    for (let d = 0; d < DIRECTIONS; d++) for (let n = 0; n < IR_LENGTH; n++) for (let ear = 0; ear < 2; ear++) peak = Math.max(peak, Math.abs(sampleAt(d, n, ear)));
    expect(peak / 32768).toBeCloseTo(0.8887, 3);
  });

  it("keeps the leading delays: at 44.1 kHz main extracts 10..50 frames per ear, and the responses then start within 40 frames", () => {
    const table = resampleHrir(asset, 44100);
    const v = new DataView(table);
    let [lo, hi] = [Infinity, 0];
    for (let i = 0; i < DIRECTIONS * 2; i++) {
      const delay = v.getFloat32(16 + i * 4, true);
      [lo, hi] = [Math.min(lo, delay), Math.max(hi, delay)];
    }
    expect(lo).toBeGreaterThan(10);
    expect(hi).toBeLessThan(50);
    const irAt = (d: number, n: number, ear: number) => v.getInt16(16 + 8 * DIRECTIONS + ((d * IR_LENGTH + n) * 2 + ear) * 2, true);
    for (const d of [0, 1, 50, 119, 200, 239]) {
      for (let ear = 0; ear < 2; ear++) {
        let peak = 0;
        for (let n = 0; n < IR_LENGTH; n++) peak = Math.max(peak, Math.abs(irAt(d, n, ear)));
        let first = -1;
        for (let n = 0; n < IR_LENGTH && first < 0; n++) if (Math.abs(irAt(d, n, ear)) > 0.1 * peak) first = n;
        expect(first, `direction ${d} ear ${ear}`).toBeGreaterThanOrEqual(0);
        expect(first, `direction ${d} ear ${ear}`).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe("source mapping", () => {
  it("maps the 240 names onto directions 0..239 in order", () => {
    const names = sourceNames();
    expect(names.length).toBe(DIRECTIONS);
    expect(names.map(directionIndex)).toEqual(Array.from({ length: DIRECTIONS }, (_, i) => i));
    expect(names[0]).toBe("IRC_Composite_C_R0195_T000_P315.wav");
    expect(names[239]).toBe("IRC_Composite_C_R0195_T345_P090.wav");
  });
});

describe("raw WAV spot checks", () => {
  const names = sourceNames();
  const haveRaw = existsSync(RAW_DIR) && names.every((n) => existsSync(join(RAW_DIR, n)));

  for (const d of [0, 239]) {
    it.skipIf(!haveRaw)(`direction ${d} holds the raw WAV's samples`, () => {
      const name = names[d]!;
      const { left, right } = parseWav(readFileSync(join(RAW_DIR, name)), name);
      for (let n = 0; n < IR_LENGTH; n++) {
        expect(sampleAt(d, n, 0)).toBe(left[n]);
        expect(sampleAt(d, n, 1)).toBe(right[n]);
      }
    });
  }

  it.skipIf(!haveRaw)("convert() of the raw set reproduces the committed asset", () => {
    const wavs = new Map(names.map((n) => [n, readFileSync(join(RAW_DIR, n))]));
    const result = convert(wavs);
    expect(result.blob.length).toBe(ASSET_BYTES);
    expect(Buffer.compare(Buffer.from(result.blob), blob)).toBe(0);
  });
});
