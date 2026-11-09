import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convert, directionIndex, extractAverageGroupDelay, parseWav, sourceNames } from "../../../../../tools/hrir/convert.mjs";

// Checks the committed myco_hrir.bin against the layout in audio-dsp's database.rs (what HrirDatabase::parse enforces).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const BLOB_PATH = join(ROOT, "src/plugins/audio/runtime/wasm/myco_hrir.bin");
const RAW_DIR = join(ROOT, "tools/hrir/raw");
const PROVENANCE_PATH = join(ROOT, "tools/hrir/PROVENANCE.json");

const BLOB_BYTES = 247_696;
const IR_OFFSET = 1936;
const IR_LENGTH = 256;
const DIRECTIONS = 240;

const blob = readFileSync(BLOB_PATH);
const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

/** The delay-table entry for direction d and ear (0 left, 1 right). */
const delayAt = (d: number, ear: number) => view.getFloat32(16 + (d * 2 + ear) * 4, true);

/** Sample n of the response for direction d, ear, as a fraction of full scale. */
const sampleAt = (d: number, n: number, ear: number) =>
  view.getInt16(IR_OFFSET + ((d * IR_LENGTH + n) * 2 + ear) * 2, true) / 32768;

describe("myco_hrir.bin", () => {
  it("has exactly the documented byte length", () => {
    expect(blob.length).toBe(BLOB_BYTES);
  });

  it("has the 10 x 24 x 256 @ 44100 header", () => {
    expect(view.getUint32(0, true)).toBe(10);
    expect(view.getUint32(4, true)).toBe(24);
    expect(view.getUint32(8, true)).toBe(256);
    expect(view.getFloat32(12, true)).toBe(44100);
  });

  it("has finite non-negative ear delays", () => {
    for (let d = 0; d < DIRECTIONS; d++) {
      for (let ear = 0; ear < 2; ear++) {
        const delay = delayAt(d, ear);
        expect(Number.isFinite(delay), `direction ${d} ear ${ear}`).toBe(true);
        expect(delay >= 0, `direction ${d} ear ${ear}`).toBe(true);
      }
    }
  });

  it("has a peak below full scale", () => {
    let peak = 0;
    for (let d = 0; d < DIRECTIONS; d++) {
      for (let n = 0; n < IR_LENGTH; n++) {
        for (let ear = 0; ear < 2; ear++) peak = Math.max(peak, Math.abs(sampleAt(d, n, ear)));
      }
    }
    expect(peak).toBeLessThan(1);
  });

  it("has its leading edge within the 20-frame headroom", () => {
    for (const d of [0, 1, 50, 119, 200, 239]) {
      for (let ear = 0; ear < 2; ear++) {
        let peak = 0;
        for (let n = 0; n < IR_LENGTH; n++) peak = Math.max(peak, Math.abs(sampleAt(d, n, ear)));
        let first = -1;
        for (let n = 0; n < IR_LENGTH; n++) {
          if (Math.abs(sampleAt(d, n, ear)) > 0.1 * peak) {
            first = n;
            break;
          }
        }
        expect(first, `direction ${d} ear ${ear}`).toBeGreaterThanOrEqual(0);
        expect(first, `direction ${d} ear ${ear}`).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe("extractAverageGroupDelay", () => {
  it("gives about 29.34 frames for an impulse at 50, with the peak at 20 or 21", () => {
    const ir = new Float64Array(IR_LENGTH);
    ir[50] = 1;
    const delay = extractAverageGroupDelay(ir);
    expect(Math.abs(delay - 29.34)).toBeLessThan(0.1);
    let peak = 0;
    for (let n = 1; n < IR_LENGTH; n++) if (Math.abs(ir[n]) > Math.abs(ir[peak])) peak = n;
    expect([20, 21]).toContain(peak);
  });

  it("leaves a silent response alone and returns 0", () => {
    const ir = new Float64Array(IR_LENGTH);
    expect(extractAverageGroupDelay(ir)).toBe(0);
    expect(ir.every((x) => x === 0)).toBe(true);
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
  const scale: number = haveRaw ? JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")).scaling.factor : 1;

  for (const d of [0, 239]) {
    it.skipIf(!haveRaw)(`direction ${d} matches a re-derivation from the raw WAV`, () => {
      const name = names[d];
      const { left, right } = parseWav(readFileSync(join(RAW_DIR, name)), name);
      const ears = [left, right];
      for (let ear = 0; ear < 2; ear++) {
        const ir = ears[ear];
        const delay = extractAverageGroupDelay(ir);
        expect(Math.abs(delayAt(d, ear) - delay)).toBeLessThan(1e-3);
        for (let n = 0; n < IR_LENGTH; n++) {
          const expected = Math.max(-32768, Math.min(32767, Math.round(ir[n] * scale * 32768)));
          expect(Math.abs(sampleAt(d, n, ear) * 32768 - expected), `direction ${d} ear ${ear} frame ${n}`).toBeLessThanOrEqual(1);
        }
      }
    });
  }

  it.skipIf(!haveRaw)("convert() of the raw set reproduces the committed blob", () => {
    const wavs = new Map(names.map((n) => [n, readFileSync(join(RAW_DIR, n))]));
    const result = convert(wavs);
    expect(result.blob.length).toBe(BLOB_BYTES);
    expect(Buffer.compare(Buffer.from(result.blob), blob)).toBe(0);
  });
});
