// The status reader (ADR 0157; api-and-models §4.3): decodes a STATUS message into one preallocated `StatusBlock`,
// so the main thread allocates nothing per block (the generated `readStatus` builds a fresh block, and fresh arrays
// and items, for every message; #66). The same checks and errors as `readStatus` (`WireError`s with codes), the
// same field offsets. The block it returns is the reader's own and is overwritten by the next `read`: consumers
// (the mirror, in `onmessage`) use it before returning.
//
// ADR 0162 (§4.3, contract C7) grows the header to 144 B (`bedVoices` … `workZones` at 112..143) and appends the
// `beds`, `zones` and `zoneEvents` sections after `peaks`; `validateM3` and `readM3` handle them (leaf L-A1b).
import {
  ErrorCode,
  Kind,
  MAGIC,
  MAX_BEDS,
  MAX_ZONE_EVENTS_PER_BLOCK,
  MAX_ZONE_SLOTS,
  STATUS_HEADER_BYTES,
  VERSION_MAJOR,
  WireError,
  type StatusBedsItem,
  type StatusBlock,
  type StatusClipEventsItem,
  type StatusPeaksItem,
  type StatusPlayheadsItem,
  type StatusStreamEventsItem,
  type StatusZoneEventsItem,
  type StatusZonesItem,
} from "../wire.generated";

const HEADER = STATUS_HEADER_BYTES;
const MAX_ENDED = 1024;
const MAX_PLAYHEADS = 256;
const MAX_EVENTS = 64;
const MAX_PEAKS = 32;
/** ADR 0162 §4.3: the M3 sections' item sizes. */
const BED_ITEM_BYTES = 8;
const ZONE_ITEM_BYTES = 12;
const ZONE_EVENT_ITEM_BYTES = 4;

export class StatusReader {
  /** The reused block. Its section arrays keep their capacity between reads; `length` is set per read. */
  readonly block: StatusBlock;

  private readonly playheadItems: StatusPlayheadsItem[] = [];
  private readonly clipItems: StatusClipEventsItem[] = [];
  private readonly streamItems: StatusStreamEventsItem[] = [];
  private readonly peakItems: StatusPeaksItem[] = [];
  private readonly bedItems: StatusBedsItem[] = [];
  private readonly zoneItems: StatusZonesItem[] = [];
  private readonly zoneEventItems: StatusZoneEventsItem[] = [];

  constructor() {
    for (let i = 0; i < MAX_PLAYHEADS; i++) this.playheadItems.push({ id: 0, clipFrame: 0 });
    for (let i = 0; i < MAX_EVENTS; i++) this.clipItems.push({ clipId: 0, code: 0 });
    for (let i = 0; i < MAX_EVENTS; i++) this.streamItems.push({ id: 0, code: 0 });
    for (let i = 0; i < MAX_PEAKS; i++) this.peakItems.push({ l: 0, r: 0 });
    for (let i = 0; i < MAX_BEDS; i++) this.bedItems.push({ bus: 0, voices: 0, work: 0 });
    for (let i = 0; i < MAX_ZONE_SLOTS; i++) this.zoneItems.push({ kernelId: 0, state: 0, pad: 0, quantaSinceInput: 0, wetPeak: 0 });
    for (let i = 0; i < MAX_ZONE_EVENTS_PER_BLOCK; i++) this.zoneEventItems.push({ slot: 0, code: 0, reserved: 0 });
    this.block = {
      currentFrame: 0,
      dateMs: 0,
      pingSeq: 0,
      pingFrameLo: 0,
      underruns: 0,
      lateCommands: 0,
      workUnits: 0,
      workUnitsMax: 0,
      mixedVoices: 0,
      liveVoices: 0,
      flags: 0,
      mixedCap: 0,
      loadPermille: 0,
      traps: 0,
      minSlackFrames: 0,
      underrunFrames: 0,
      arenaUsedKB: 0,
      arenaLargestFreeKB: 0,
      abiVersion: 0,
      maxLatenessFrames: 0,
      hrtfVoices: 0,
      hrtfLoadFailure: 0,
      bedVoices: 0,
      fxVoices: 0,
      ambisonicVoices: 0,
      zonesActive: 0,
      zonesRinging: 0,
      bedsRefused: 0,
      reserved: 0,
      zoneUsedKB: 0,
      workBed: 0,
      workZones: 0,
      ended: [],
      demoted: [],
      starved: [],
      playheads: [],
      clipEvents: [],
      streamEvents: [],
      peaks: [],
      beds: [],
      zones: [],
      zoneEvents: [],
    };
    // Warm the id arrays to full size once, so later reads only set `length` and indices.
    for (const list of [this.block.ended, this.block.demoted, this.block.starved]) {
      for (let i = 0; i < MAX_ENDED; i++) list.push(0);
      list.length = 0;
    }
  }

  /** Decodes `buffer` (envelope first) into `block` and returns it. Throws `WireError` as `readStatus` does. */
  read(buffer: ArrayBuffer | ArrayBufferView): StatusBlock {
    const view = buffer instanceof ArrayBuffer ? new DataView(buffer) : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (HEADER > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");
    if (view.getUint32(0, true) !== MAGIC) throw new WireError(ErrorCode.BAD_MAGIC, "STATUS: bad magic");
    if (view.getUint16(4, true) >> 8 !== VERSION_MAJOR) throw new WireError(ErrorCode.VERSION_MISMATCH, "STATUS: version mismatch");
    if (view.getUint16(6, true) !== Kind.STATUS) throw new WireError(ErrorCode.MALFORMED, "STATUS: wrong kind");
    const limit = 16 + view.getUint32(12, true);
    if (limit > view.byteLength || limit < HEADER) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");

    const endedCount = view.getUint16(64, true);
    const demotedCount = view.getUint16(66, true);
    const starvedCount = view.getUint16(68, true);
    const playheadCount = view.getUint16(70, true);
    const busCount = view.getUint16(72, true);
    const clipEventCount = view.getUint16(74, true);
    const streamEventCount = view.getUint16(76, true);
    // Validate every section before touching the block, so a refused message leaves it as it was.
    let cur = HEADER;
    if (endedCount > MAX_ENDED || endedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: ended overrun");
    cur += endedCount * 4;
    if (demotedCount > MAX_ENDED || demotedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: demoted overrun");
    cur += demotedCount * 4;
    if (starvedCount > MAX_ENDED || starvedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: starved overrun");
    cur += starvedCount * 4;
    if (playheadCount > MAX_PLAYHEADS || playheadCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: playheads overrun");
    cur += playheadCount * 8;
    if (clipEventCount > MAX_EVENTS || clipEventCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: clipEvents overrun");
    cur += clipEventCount * 8;
    if (streamEventCount > MAX_EVENTS || streamEventCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: streamEvents overrun");
    cur += streamEventCount * 8;
    if (busCount > MAX_PEAKS || busCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: peaks overrun");
    cur += busCount * 8;
    this.validateM3(view, cur, limit);

    const b = this.block;
    b.currentFrame = view.getFloat64(16, true);
    b.dateMs = view.getFloat64(24, true);
    b.pingSeq = view.getUint32(32, true);
    b.pingFrameLo = view.getUint32(36, true);
    b.underruns = view.getUint32(40, true);
    b.lateCommands = view.getUint32(44, true);
    b.workUnits = view.getUint32(48, true);
    b.workUnitsMax = view.getUint32(52, true);
    b.mixedVoices = view.getUint16(56, true);
    b.liveVoices = view.getUint16(58, true);
    b.flags = view.getUint32(60, true);
    b.mixedCap = view.getUint16(78, true);
    b.loadPermille = view.getUint16(80, true);
    b.traps = view.getUint16(82, true);
    b.minSlackFrames = view.getInt32(84, true);
    b.underrunFrames = view.getUint32(88, true);
    b.arenaUsedKB = view.getUint32(92, true);
    b.arenaLargestFreeKB = view.getUint32(96, true);
    b.abiVersion = view.getUint32(100, true);
    b.maxLatenessFrames = view.getUint32(104, true);
    b.hrtfVoices = view.getUint16(108, true);
    b.hrtfLoadFailure = view.getUint16(110, true);

    cur = HEADER;
    cur = this.ids(view, cur, endedCount, b.ended);
    cur = this.ids(view, cur, demotedCount, b.demoted);
    cur = this.ids(view, cur, starvedCount, b.starved);
    const playheads = b.playheads;
    for (let i = 0; i < playheadCount; i++, cur += 8) {
      const item = this.playheadItems[i]!;
      item.id = view.getUint32(cur, true);
      item.clipFrame = view.getUint32(cur + 4, true);
      playheads[i] = item;
    }
    playheads.length = playheadCount;
    const clipEvents = b.clipEvents;
    for (let i = 0; i < clipEventCount; i++, cur += 8) {
      const item = this.clipItems[i]!;
      item.clipId = view.getUint32(cur, true);
      item.code = view.getUint32(cur + 4, true);
      clipEvents[i] = item;
    }
    clipEvents.length = clipEventCount;
    const streamEvents = b.streamEvents;
    for (let i = 0; i < streamEventCount; i++, cur += 8) {
      const item = this.streamItems[i]!;
      item.id = view.getUint32(cur, true);
      item.code = view.getUint32(cur + 4, true);
      streamEvents[i] = item;
    }
    streamEvents.length = streamEventCount;
    const peaks = b.peaks;
    for (let i = 0; i < busCount; i++, cur += 8) {
      const item = this.peakItems[i]!;
      item.l = view.getFloat32(cur, true);
      item.r = view.getFloat32(cur + 4, true);
      peaks[i] = item;
    }
    peaks.length = busCount;
    this.readM3(view, cur);
    return b;
  }

  /**
   * ADR 0162 §4.3: checks the `beds` (`bedsActive` at 114, at most `MAX_BEDS`, 8 B each), `zones` (`zoneSlots` at 128,
   * at most `MAX_ZONE_SLOTS`, 12 B each) and `zoneEvents` (`zoneEventCount` at 124, at most
   * `MAX_ZONE_EVENTS_PER_BLOCK`, 4 B each) sections, which start at `at` (just after `peaks`), against their caps and
   * `limit`, throwing `WireError(OVERSIZE, "STATUS: <section> overrun")` as `readStatus` does. Touches nothing: it runs
   * before the block is written, so a refused message leaves the block as it was.
   */
  private validateM3(view: DataView, at: number, limit: number): void {
    const bedCount = view.getUint16(114, true);
    const zoneCount = view.getUint16(128, true);
    const zoneEventCount = view.getUint16(124, true);
    let cur = at;
    if (bedCount > MAX_BEDS || bedCount * BED_ITEM_BYTES > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: beds overrun");
    cur += bedCount * BED_ITEM_BYTES;
    if (zoneCount > MAX_ZONE_SLOTS || zoneCount * ZONE_ITEM_BYTES > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: zones overrun");
    cur += zoneCount * ZONE_ITEM_BYTES;
    if (zoneEventCount > MAX_ZONE_EVENTS_PER_BLOCK || zoneEventCount * ZONE_EVENT_ITEM_BYTES > limit - cur) {
      throw new WireError(ErrorCode.OVERSIZE, "STATUS: zoneEvents overrun");
    }
  }

  /**
   * ADR 0162 §4.3: reads the 144-byte header's M3 fields (112..143: `bedVoices`, `fxVoices`, `ambisonicVoices`,
   * `zonesActive`, `zonesRinging`, `bedsRefused`, `reserved`, `zoneUsedKB`, `workBed`, `workZones`; the three counts
   * are the section lengths) into `block`, then the three sections from `at` into the preallocated `bedItems`,
   * `zoneItems` and `zoneEventItems`, setting each section array's `length`. Allocates nothing. `validateM3` has
   * already checked the bounds.
   */
  private readM3(view: DataView, at: number): void {
    const b = this.block;
    b.bedVoices = view.getUint16(112, true);
    b.fxVoices = view.getUint16(116, true);
    b.ambisonicVoices = view.getUint16(118, true);
    b.zonesActive = view.getUint16(120, true);
    b.zonesRinging = view.getUint16(122, true);
    b.bedsRefused = view.getUint16(126, true);
    b.reserved = view.getUint16(130, true);
    b.zoneUsedKB = view.getUint32(132, true);
    b.workBed = view.getUint32(136, true);
    b.workZones = view.getUint32(140, true);

    const bedCount = view.getUint16(114, true);
    const zoneCount = view.getUint16(128, true);
    const zoneEventCount = view.getUint16(124, true);
    let cur = at;
    const beds = b.beds;
    for (let i = 0; i < bedCount; i++, cur += BED_ITEM_BYTES) {
      const item = this.bedItems[i]!;
      item.bus = view.getUint16(cur, true);
      item.voices = view.getUint16(cur + 2, true);
      item.work = view.getUint32(cur + 4, true);
      beds[i] = item;
    }
    beds.length = bedCount;
    const zones = b.zones;
    for (let i = 0; i < zoneCount; i++, cur += ZONE_ITEM_BYTES) {
      const item = this.zoneItems[i]!;
      item.kernelId = view.getUint32(cur, true);
      item.state = view.getUint8(cur + 4);
      item.pad = view.getUint8(cur + 5);
      item.quantaSinceInput = view.getUint16(cur + 6, true);
      item.wetPeak = view.getFloat32(cur + 8, true);
      zones[i] = item;
    }
    zones.length = zoneCount;
    const zoneEvents = b.zoneEvents;
    for (let i = 0; i < zoneEventCount; i++, cur += ZONE_EVENT_ITEM_BYTES) {
      const item = this.zoneEventItems[i]!;
      item.slot = view.getUint8(cur);
      item.code = view.getUint8(cur + 1);
      item.reserved = view.getUint16(cur + 2, true);
      zoneEvents[i] = item;
    }
    zoneEvents.length = zoneEventCount;
  }

  private ids(view: DataView, at: number, count: number, out: number[]): number {
    let cur = at;
    for (let i = 0; i < count; i++, cur += 4) out[i] = view.getUint32(cur, true);
    out.length = count;
    return cur;
  }
}
