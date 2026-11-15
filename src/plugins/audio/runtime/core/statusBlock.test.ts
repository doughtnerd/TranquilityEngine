// ADR 0177: the STATUS block described once. One generated round trip: a block with a distinct value in every header
// field and an item in every section goes out through the generated `writeStatus` and comes back, field by field and by
// name, through the generated `readStatus`, the zero-allocation `StatusBlockReader` (and the hand `StatusReader` over
// it), the mirror's `header` record and the capture's columns. Field names come from the generated tables, never from a
// hand list, so a field added to the schema is covered with no edit here. Plus what is hand code: the count-sum rule.
import { describe, expect, it } from "vitest";
import * as wire from "../wire.generated";
import {
  ErrorCode,
  LOUD_FLAG_NEW_BLOCKS_MASK,
  readStatus,
  readStatusHeaderField,
  STATUS_BUFFER_BYTES,
  STATUS_HEADER_BYTES,
  STATUS_HEADER_COLUMNS,
  STATUS_SECTION,
  STATUS_SECTION_COUNT_AT,
  STATUS_SECTION_MAX,
  StatusBlockReader,
  WireError,
  writeStatus,
  type StatusBlock,
  type StatusHeaderField,
} from "../wire.generated";
import { RecordType, assembleCapture } from "../capture/format";
import { CaptureTimeIndex, STATUS_COLUMNS, openCapture, rangeCapture, readStatusColumn } from "../capture/reader";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, sampleRecords } from "../capture/testSupport";
import { StatusMirror, makeStatusBlock } from "./mirror";
import { StatusReader } from "./statusReader";
import { VoiceTable } from "./voiceTable";

const FIELDS = Object.keys(STATUS_HEADER_COLUMNS) as StatusHeaderField[];
const SECTIONS = Object.keys(STATUS_SECTION) as (keyof typeof STATUS_SECTION)[];
/** The capture sample's first STATUS sits at frame 768; the block's `currentFrame` must match its record's frame. */
const FRAME = 768;

const screaming = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
/** A multi-field section's item field offsets (the generated `STATUS_<SECTION>_ITEM_AT`); undefined for a number section. */
const itemAt = (section: string): Record<string, number> | undefined => (wire as unknown as Record<string, Record<string, number> | undefined>)[`STATUS_${screaming(section)}_ITEM_AT`];

/** Distinct values in every header field (exact in its type) and `items` items in every section; loudBuses flags sum to the energies. */
function fullBlock(items = 2): StatusBlock {
  const block = makeStatusBlock();
  const h = block as unknown as Record<string, number>;
  FIELDS.forEach((f, n) => {
    const ty = STATUS_HEADER_COLUMNS[f][1];
    h[f] = ty === "f64" ? n + 0.5 : ty === "i32" ? -(n + 1) : ty === "u32" ? 70_000 + n : n + 1;
  });
  block.currentFrame = FRAME;
  let v = 1;
  const lists = block as unknown as Record<string, unknown[]>;
  for (const s of SECTIONS) {
    const at = itemAt(s);
    // Small integers: exact in every item type (u8 to f32).
    lists[s] = Array.from({ length: items }, () => (at ? Object.fromEntries(Object.keys(at).map((k) => [k, v++ % 250])) : v++ % 250));
  }
  block.loudBuses.forEach((b, i) => (b.flags = i + 1));
  block.loudEnergies = Array.from({ length: block.loudBuses.reduce((sum, b) => sum + (b.flags & LOUD_FLAG_NEW_BLOCKS_MASK), 0) }, (_, i) => i + 1);
  return block;
}

function encode(block: StatusBlock): ArrayBuffer {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, block, 1);
  return buffer;
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return `${(e as WireError).code} ${(e as Error).message}`;
  }
  return "none";
};

describe("the STATUS block, generated once (ADR 0177)", () => {
  it("round-trips every header field and section by name: writeStatus, readStatus, StatusBlockReader, StatusReader, the mirror's header and the capture's columns", async () => {
    const block = fullBlock();
    const buffer = encode(block);
    const view = new DataView(buffer);

    // The generated readers, the allocating one and the reusable one (bare, and with the hand count-sum check).
    expect(readStatus(buffer)).toEqual(block);
    expect(new StatusBlockReader().read(buffer)).toEqual(block);
    const read = new StatusReader().readView(view);
    expect(read).toEqual(block);
    for (const s of SECTIONS) expect([s, read[s].length]).toEqual([s, block[s].length]);

    // In place, by name: the generated column reader and the capture's (the same table).
    expect(STATUS_COLUMNS).toBe(STATUS_HEADER_COLUMNS);
    for (const f of FIELDS) {
      expect([f, readStatusHeaderField(view, 0, f)]).toEqual([f, block[f]]);
      expect([f, readStatusColumn(view, 0, f)]).toEqual([f, block[f]]);
    }

    // The mirror keeps the newest header as one record: every field by name.
    const mirror = new StatusMirror(new VoiceTable(8));
    mirror.apply(read);
    for (const f of FIELDS) expect([f, mirror.header[f]]).toEqual([f, block[f]]);

    // A saved capture: the block as the sample's first STATUS record, then `range` over every column by name.
    const records = sampleRecords().map((r) => (r.type === RecordType.STATUS && r.frame === FRAME && r.epoch === 0 ? { ...r, payload: new Uint8Array(buffer, 0, view.getUint32(12, true) + 16) } : r));
    const c = await openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, records, { index: true }));
    const idx = new CaptureTimeIndex();
    idx.extend(c);
    const range = rangeCapture(c, idx, FRAME / SAMPLE_RATE, FRAME / SAMPLE_RATE, FIELDS);
    for (const f of FIELDS) expect([f, Array.from(range[f]!)]).toEqual([f, [block[f]]]);
  });

  it("refuses what readStatus refuses, with the same codes and messages, and a refused message leaves the block as it was", () => {
    const good = encode(fullBlock(1));
    const cases: ArrayBuffer[] = [new ArrayBuffer(50)];
    const patch = (set: (v: DataView) => void): void => {
      const copy = good.slice(0);
      set(new DataView(copy));
      cases.push(copy);
    };
    patch((v) => v.setUint32(0, 0, true));
    patch((v) => v.setUint16(4, 0x0200, true));
    patch((v) => v.setUint16(6, wire.Kind.BATCH, true));
    patch((v) => v.setUint32(12, 100_000, true));
    patch((v) => v.setUint32(12, STATUS_HEADER_BYTES - 17, true));
    // Every section over its cap, and every section past the body's end (the generated count offsets and caps).
    for (const s of SECTIONS) {
      patch((v) => v.setUint16(STATUS_SECTION_COUNT_AT[s], STATUS_SECTION_MAX[s] + 1, true));
      patch((v) => v.setUint16(STATUS_SECTION_COUNT_AT[s], Math.min(STATUS_SECTION_MAX[s], 3), true));
    }
    const reader = new StatusBlockReader();
    const kept = reader.read(good);
    const before = structuredClone(kept);
    let refused = 0;
    for (const bad of cases) {
      const expected = codeOf(() => readStatus(bad));
      if (expected === "none") continue; // a count of 3 that still fits the body
      refused++;
      expect(codeOf(() => reader.read(bad))).toBe(expected);
      expect(reader.block).toEqual(before);
    }
    expect(refused).toBeGreaterThan(5 + SECTIONS.length);
    expect(Number(codeOf(() => reader.read(cases[0]!)).split(" ")[0])).toBe(ErrorCode.TRUNCATED);
  });

  it("allocates nothing per block: the block, its arrays and its items are the reader's own across 3,000 reads of the largest and an empty block", () => {
    const reader = new StatusReader();
    const big = encode(fullBlock(4));
    const empty = encode(makeStatusBlock());
    const owned = (b: StatusBlock): unknown[] => {
      const out: unknown[] = [b];
      for (const s of SECTIONS) out.push(b[s], ...(b[s] as unknown[]).filter((x) => typeof x === "object"));
      return out;
    };
    const first = owned(reader.read(big));
    for (let i = 0; i < 3000; i++) reader.readView(new DataView(i % 2 === 0 ? big : empty));
    const last = owned(reader.read(big));
    expect(last.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) expect(last[i]).toBe(first[i]);
    expect(reader.read(empty).ended).toHaveLength(0);
  });

  it("the hand rule (ADR 0171 §4.3): loudBuses new-block counts (flags & 0x3F) must sum to loudEnergyCount, else MALFORMED; the bare generated reader doesn't know it", () => {
    const block = fullBlock(2); // flags 1 and 2: three energies
    const good = encode(block);
    expect(new StatusReader().read(good).loudEnergies).toHaveLength(3);
    const bad = encode({ ...block, loudEnergies: [1, 2] });
    expect(codeOf(() => new StatusReader().read(bad))).toBe(`${ErrorCode.MALFORMED} STATUS: loudEnergies count sum`);
    expect(new StatusBlockReader().read(bad).loudEnergies).toEqual([1, 2]);
    // The other flag bits are not counts.
    const paused = encode({ ...block, loudBuses: block.loudBuses.map((b) => ({ ...b, flags: b.flags | wire.LOUD_FLAG_PAUSED })) });
    expect(new StatusReader().read(paused).loudEnergies).toHaveLength(3);
  });
});
