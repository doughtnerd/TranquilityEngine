import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// ../../../../src/plugins/audio/runtime/wire.generated.ts
function writeEnvelope(view, off, rec) {
  view.setUint32(off + 0, rec.magic ?? MAGIC, true);
  view.setUint16(off + 4, rec.version ?? VERSION_MAJOR << 8 | VERSION_MINOR, true);
  view.setUint16(off + 6, rec.kind, true);
  view.setUint32(off + 8, rec.seq, true);
  view.setUint32(off + 12, rec.bodyBytes, true);
  let cur = off + 16;
  return cur - off;
}
function _readEnvelope(view, off, limit) {
  if (off + 16 > limit) throw new WireError(ErrorCode.TRUNCATED, "Envelope: truncated");
  const magic = view.getUint32(off + 0, true);
  const version = view.getUint16(off + 4, true);
  const kind = view.getUint16(off + 6, true);
  const seq = view.getUint32(off + 8, true);
  const bodyBytes = view.getUint32(off + 12, true);
  let cur = off + 16;
  return [{ magic, version, kind, seq, bodyBytes }, cur - off];
}
function readEnvelope(view, off) {
  const limit = view.byteLength;
  return _readEnvelope(view, off, limit)[0];
}
function writeBatchHeader(view, off, rec) {
  view.setFloat64(off + 16, rec.firstFrame, true);
  view.setUint32(off + 24, rec.count, true);
  view.setUint32(off + 28, rec.flags, true);
  let cur = off + 32;
  return cur - off;
}
function writeClipBegin(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  view.setUint32(off + 20, rec.frames, true);
  view.setUint32(off + 24, rec.channels, true);
  view.setFloat32(off + 28, rec.sampleRate, true);
  view.setUint32(off + 32, rec.format, true);
  let cur = off + 36;
  return cur - off;
}
function _readClipBegin(view, off, limit) {
  if (off + 36 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipBegin: truncated");
  const clipId = view.getUint32(off + 16, true);
  const frames = view.getUint32(off + 20, true);
  const channels = view.getUint32(off + 24, true);
  const sampleRate = view.getFloat32(off + 28, true);
  const format = view.getUint32(off + 32, true);
  let cur = off + 36;
  return [{ clipId, frames, channels, sampleRate, format }, cur - off];
}
function readClipBegin(view, off) {
  const limit = view.byteLength;
  return _readClipBegin(view, off, limit)[0];
}
function writeClipChunk(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  view.setUint32(off + 20, rec.frameOffset, true);
  view.setUint32(off + 24, rec.frames, true);
  view.setUint32(off + 28, rec.reserved, true);
  let cur = off + 32;
  return cur - off;
}
function _readClipChunk(view, off, limit) {
  if (off + 32 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipChunk: truncated");
  const clipId = view.getUint32(off + 16, true);
  const frameOffset = view.getUint32(off + 20, true);
  const frames = view.getUint32(off + 24, true);
  const reserved = view.getUint32(off + 28, true);
  let cur = off + 32;
  return [{ clipId, frameOffset, frames, reserved }, cur - off];
}
function readClipChunk(view, off) {
  const limit = view.byteLength;
  return _readClipChunk(view, off, limit)[0];
}
function writeClipUnload(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  let cur = off + 20;
  return cur - off;
}
function _readClipUnload(view, off, limit) {
  if (off + 20 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipUnload: truncated");
  const clipId = view.getUint32(off + 16, true);
  let cur = off + 20;
  return [{ clipId }, cur - off];
}
function readClipUnload(view, off) {
  const limit = view.byteLength;
  return _readClipUnload(view, off, limit)[0];
}
function _readStreamOpen(view, off, limit) {
  if (off + 56 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamOpen: truncated");
  const streamId = view.getUint32(off + 16, true);
  const channels = view.getUint32(off + 20, true);
  const sampleRate = view.getFloat32(off + 24, true);
  const totalFrames = view.getUint32(off + 28, true);
  const loopStart = view.getUint32(off + 32, true);
  const loopEnd = view.getUint32(off + 36, true);
  const flags = view.getUint32(off + 40, true);
  const epoch = view.getUint32(off + 44, true);
  const startFrame = view.getUint32(off + 48, true);
  const convention = view.getUint32(off + 52, true);
  let cur = off + 56;
  return [{ streamId, channels, sampleRate, totalFrames, loopStart, loopEnd, flags, epoch, startFrame, convention }, cur - off];
}
function readStreamOpen(view, off) {
  const limit = view.byteLength;
  return _readStreamOpen(view, off, limit)[0];
}
function _readStreamChunk(view, off, limit) {
  if (off + 36 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamChunk: truncated");
  const streamId = view.getUint32(off + 16, true);
  const chunkSeq = view.getUint32(off + 20, true);
  const frames = view.getUint32(off + 24, true);
  const flags = view.getUint32(off + 28, true);
  const epoch = view.getUint32(off + 32, true);
  let cur = off + 36;
  return [{ streamId, chunkSeq, frames, flags, epoch }, cur - off];
}
function readStreamChunk(view, off) {
  const limit = view.byteLength;
  return _readStreamChunk(view, off, limit)[0];
}
function writeStreamClose(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  let cur = off + 20;
  return cur - off;
}
function _readStreamClose(view, off, limit) {
  if (off + 20 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamClose: truncated");
  const streamId = view.getUint32(off + 16, true);
  let cur = off + 20;
  return [{ streamId }, cur - off];
}
function readStreamClose(view, off) {
  const limit = view.byteLength;
  return _readStreamClose(view, off, limit)[0];
}
function writeTimePing(view, off, rec) {
  view.setUint32(off + 16, rec.pingSeq, true);
  let cur = off + 20;
  return cur - off;
}
function writeStreamCredit(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  view.setUint32(off + 20, rec.epoch, true);
  view.setUint32(off + 24, rec.consumedFrames, true);
  view.setUint32(off + 28, rec.returnedBuffers, true);
  let cur = off + 32;
  return cur - off;
}
function writePlay(view, off, rec) {
  view.setUint32(off + 12, rec.clip, true);
  view.setUint16(off + 16, rec.bus, true);
  view.setUint16(off + 18, rec.flags, true);
  view.setUint16(off + 20, rec.group, true);
  view.setUint16(off + 22, rec.gate, true);
  view.setFloat32(off + 24, rec.gain, true);
  view.setFloat32(off + 28, rec.pitch, true);
  view.setFloat32(off + 32, rec.dirX, true);
  view.setFloat32(off + 36, rec.dirY, true);
  view.setFloat32(off + 40, rec.dirZ, true);
  view.setFloat32(off + 44, rec.lpHz, true);
  view.setFloat32(off + 48, rec.score, true);
  view.setUint32(off + 52, rec.startOffsetFrames, true);
  let cur = off + 56;
  const total = cur - off;
  if (total % 4 !== 0 || total / 4 > 65535) throw new WireError(ErrorCode.OVERSIZE, "Play: record too long");
  view.setUint16(off + 0, 1, true);
  view.setUint16(off + 2, total / 4, true);
  view.setUint32(off + 4, rec.voiceId, true);
  view.setUint32(off + 8, rec.frameOffset, true);
  return cur - off;
}
function writeStop(view, off, rec) {
  view.setUint32(off + 12, rec.fadeFrames, true);
  view.setUint32(off + 16, rec.reason, true);
  view.setUint32(off + 20, rec.shape ?? 0, true);
  let cur = off + 24;
  const total = cur - off;
  if (total % 4 !== 0 || total / 4 > 65535) throw new WireError(ErrorCode.OVERSIZE, "Stop: record too long");
  view.setUint16(off + 0, 2, true);
  view.setUint16(off + 2, total / 4, true);
  view.setUint32(off + 4, rec.voiceId, true);
  view.setUint32(off + 8, rec.frameOffset, true);
  return cur - off;
}
function writeSetParams(view, off, rec) {
  view.setUint32(off + 12, rec.mask, true);
  view.setFloat32(off + 16, rec.gain, true);
  view.setFloat32(off + 20, rec.pitch, true);
  view.setFloat32(off + 24, rec.dirX, true);
  view.setFloat32(off + 28, rec.dirY, true);
  view.setFloat32(off + 32, rec.dirZ, true);
  view.setFloat32(off + 36, rec.lpHz, true);
  view.setFloat32(off + 40, rec.score, true);
  view.setUint32(off + 44, rec.bus, true);
  view.setUint32(off + 48, rec.rampFrames, true);
  view.setUint32(off + 52, rec.flags, true);
  view.setUint32(off + 56, rec.shape ?? 0, true);
  let cur = off + 60;
  const total = cur - off;
  if (total % 4 !== 0 || total / 4 > 65535) throw new WireError(ErrorCode.OVERSIZE, "SetParams: record too long");
  view.setUint16(off + 0, 3, true);
  view.setUint16(off + 2, total / 4, true);
  view.setUint32(off + 4, rec.voiceId, true);
  view.setUint32(off + 8, rec.frameOffset, true);
  return cur - off;
}
function writeBusConfigBusesEffects(view, off, rec) {
  view.setUint32(off + 0, rec.type, true);
  for (let i = 0; i < 7; i++) view.setFloat32(off + 4 + i * 4, rec.p[i], true);
  let cur = off + 32;
  return cur - off;
}
function writeBusConfigBuses(view, off, rec) {
  view.setUint16(off + 0, rec.parent, true);
  view.setUint16(off + 2, rec.effects.length, true);
  let cur = off + 4;
  for (const item of rec.effects) cur += writeBusConfigBusesEffects(view, cur, item);
  return cur - off;
}
function writeBusConfig(view, off, rec) {
  view.setUint32(off + 12, rec.buses.length, true);
  let cur = off + 16;
  for (const item of rec.buses) cur += writeBusConfigBuses(view, cur, item);
  const total = cur - off;
  if (total % 4 !== 0 || total / 4 > 65535) throw new WireError(ErrorCode.OVERSIZE, "BusConfig: record too long");
  view.setUint16(off + 0, 16, true);
  view.setUint16(off + 2, total / 4, true);
  view.setUint32(off + 4, rec.voiceId, true);
  view.setUint32(off + 8, rec.frameOffset, true);
  return cur - off;
}
function writeBusMixBuses(view, off, rec) {
  view.setFloat32(off + 0, rec.gain, true);
  view.setFloat32(off + 4, rec.lpHz, true);
  let cur = off + 8;
  return cur - off;
}
function writeBusMix(view, off, rec) {
  view.setUint32(off + 12, rec.buses.length, true);
  view.setUint32(off + 16, rec.rampFrames, true);
  let cur = off + 20;
  for (const item of rec.buses) cur += writeBusMixBuses(view, cur, item);
  const total = cur - off;
  if (total % 4 !== 0 || total / 4 > 65535) throw new WireError(ErrorCode.OVERSIZE, "BusMix: record too long");
  view.setUint16(off + 0, 17, true);
  view.setUint16(off + 2, total / 4, true);
  view.setUint32(off + 4, rec.voiceId, true);
  view.setUint32(off + 8, rec.frameOffset, true);
  return cur - off;
}
function _readStatusPlayheadsItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusPlayheadsItem: truncated");
  const id = view.getUint32(off + 0, true);
  const clipFrame = view.getUint32(off + 4, true);
  let cur = off + 8;
  return [{ id, clipFrame }, cur - off];
}
function readStatusPlayheadsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusPlayheadsItem(view, off, limit)[0];
}
function _readStatusClipEventsItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusClipEventsItem: truncated");
  const clipId = view.getUint32(off + 0, true);
  const code = view.getUint32(off + 4, true);
  let cur = off + 8;
  return [{ clipId, code }, cur - off];
}
function readStatusClipEventsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusClipEventsItem(view, off, limit)[0];
}
function _readStatusStreamEventsItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusStreamEventsItem: truncated");
  const id = view.getUint32(off + 0, true);
  const code = view.getUint32(off + 4, true);
  let cur = off + 8;
  return [{ id, code }, cur - off];
}
function readStatusStreamEventsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusStreamEventsItem(view, off, limit)[0];
}
function _readStatusPeaksItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusPeaksItem: truncated");
  const l = view.getFloat32(off + 0, true);
  const r = view.getFloat32(off + 4, true);
  let cur = off + 8;
  return [{ l, r }, cur - off];
}
function readStatusPeaksItem(view, off) {
  const limit = view.byteLength;
  return _readStatusPeaksItem(view, off, limit)[0];
}
function _readStatusBedsItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusBedsItem: truncated");
  const bus = view.getUint16(off + 0, true);
  const voices = view.getUint16(off + 2, true);
  const work = view.getUint32(off + 4, true);
  let cur = off + 8;
  return [{ bus, voices, work }, cur - off];
}
function readStatusBedsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusBedsItem(view, off, limit)[0];
}
function _readStatusZonesItem(view, off, limit) {
  if (off + 12 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusZonesItem: truncated");
  const kernelId = view.getUint32(off + 0, true);
  const state = view.getUint8(off + 4);
  const pad = view.getUint8(off + 5);
  const quantaSinceInput = view.getUint16(off + 6, true);
  const wetPeak = view.getFloat32(off + 8, true);
  let cur = off + 12;
  return [{ kernelId, state, pad, quantaSinceInput, wetPeak }, cur - off];
}
function readStatusZonesItem(view, off) {
  const limit = view.byteLength;
  return _readStatusZonesItem(view, off, limit)[0];
}
function _readStatusZoneEventsItem(view, off, limit) {
  if (off + 4 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusZoneEventsItem: truncated");
  const slot = view.getUint8(off + 0);
  const code = view.getUint8(off + 1);
  const reserved = view.getUint16(off + 2, true);
  let cur = off + 4;
  return [{ slot, code, reserved }, cur - off];
}
function readStatusZoneEventsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusZoneEventsItem(view, off, limit)[0];
}
function _readStatusMusicRingsItem(view, off, limit) {
  if (off + 8 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusMusicRingsItem: truncated");
  const streamId = view.getUint32(off + 0, true);
  const epochFlags = view.getUint32(off + 4, true);
  let cur = off + 8;
  return [{ streamId, epochFlags }, cur - off];
}
function readStatusMusicRingsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusMusicRingsItem(view, off, limit)[0];
}
function _readStatusGroupStartsItem(view, off, limit) {
  if (off + 16 > limit) throw new WireError(ErrorCode.TRUNCATED, "StatusGroupStartsItem: truncated");
  const groupId = view.getUint16(off + 0, true);
  const flags = view.getUint16(off + 2, true);
  const slipFrames = view.getUint32(off + 4, true);
  const startFrameLo = view.getUint32(off + 8, true);
  const startFrameHi = view.getUint32(off + 12, true);
  let cur = off + 16;
  return [{ groupId, flags, slipFrames, startFrameLo, startFrameHi }, cur - off];
}
function readStatusGroupStartsItem(view, off) {
  const limit = view.byteLength;
  return _readStatusGroupStartsItem(view, off, limit)[0];
}
function readStatus(buf) {
  const view = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const off = 0;
  if (176 > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");
  const env = readEnvelope(view, 0);
  if (env.magic !== MAGIC) throw new WireError(ErrorCode.BAD_MAGIC, "STATUS: bad magic");
  if ((env.version ?? 0) >> 8 !== VERSION_MAJOR) throw new WireError(ErrorCode.VERSION_MISMATCH, "STATUS: version mismatch");
  if (env.kind !== Kind.STATUS) throw new WireError(ErrorCode.MALFORMED, "STATUS: wrong kind");
  const limit = 16 + env.bodyBytes;
  if (limit > view.byteLength || limit < 176) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");
  const currentFrame = view.getFloat64(off + 16, true);
  const dateMs = view.getFloat64(off + 24, true);
  const pingSeq = view.getUint32(off + 32, true);
  const pingFrameLo = view.getUint32(off + 36, true);
  const underruns = view.getUint32(off + 40, true);
  const lateCommands = view.getUint32(off + 44, true);
  const workUnits = view.getUint32(off + 48, true);
  const workUnitsMax = view.getUint32(off + 52, true);
  const mixedVoices = view.getUint16(off + 56, true);
  const liveVoices = view.getUint16(off + 58, true);
  const flags = view.getUint32(off + 60, true);
  const endedCount = view.getUint16(off + 64, true);
  const demotedCount = view.getUint16(off + 66, true);
  const starvedCount = view.getUint16(off + 68, true);
  const playheadCount = view.getUint16(off + 70, true);
  const busCount = view.getUint16(off + 72, true);
  const clipEventCount = view.getUint16(off + 74, true);
  const streamEventCount = view.getUint16(off + 76, true);
  const mixedCap = view.getUint16(off + 78, true);
  const loadPermille = view.getUint16(off + 80, true);
  const traps = view.getUint16(off + 82, true);
  const minSlackFrames = view.getInt32(off + 84, true);
  const underrunFrames = view.getUint32(off + 88, true);
  const arenaUsedKB = view.getUint32(off + 92, true);
  const arenaLargestFreeKB = view.getUint32(off + 96, true);
  const abiVersion = view.getUint32(off + 100, true);
  const maxLatenessFrames = view.getUint32(off + 104, true);
  const hrtfVoices = view.getUint16(off + 108, true);
  const hrtfLoadFailure = view.getUint16(off + 110, true);
  const bedVoices = view.getUint16(off + 112, true);
  const bedsActive = view.getUint16(off + 114, true);
  const fxVoices = view.getUint16(off + 116, true);
  const ambisonicVoices = view.getUint16(off + 118, true);
  const zonesActive = view.getUint16(off + 120, true);
  const zonesRinging = view.getUint16(off + 122, true);
  const zoneEventCount = view.getUint16(off + 124, true);
  const bedsRefused = view.getUint16(off + 126, true);
  const zoneSlots = view.getUint16(off + 128, true);
  const m3Shed = view.getUint16(off + 130, true);
  const zoneUsedKB = view.getUint32(off + 132, true);
  const workBed = view.getUint32(off + 136, true);
  const workZones = view.getUint32(off + 140, true);
  const musicRingCount = view.getUint16(off + 144, true);
  const groupStartCount = view.getUint16(off + 146, true);
  const musicRingsOpen = view.getUint16(off + 148, true);
  const streamStartsLate = view.getUint16(off + 150, true);
  const groupsLate = view.getUint16(off + 152, true);
  const groupsHeld = view.getUint16(off + 154, true);
  const groupsAbandoned = view.getUint16(off + 156, true);
  const curvePoolFull = view.getUint16(off + 158, true);
  const maxSlipFrames = view.getUint32(off + 160, true);
  const splitQuanta = view.getUint32(off + 164, true);
  const voiceSplits = view.getUint32(off + 168, true);
  const reserved = view.getUint32(off + 172, true);
  let cur = 176;
  if (endedCount > 1024 || endedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: ended overrun");
  const ended = [];
  for (let i = 0; i < endedCount; i++) {
    ended.push(view.getUint32(cur, true));
    cur += 4;
  }
  if (demotedCount > 1024 || demotedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: demoted overrun");
  const demoted = [];
  for (let i = 0; i < demotedCount; i++) {
    demoted.push(view.getUint32(cur, true));
    cur += 4;
  }
  if (starvedCount > 1024 || starvedCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: starved overrun");
  const starved = [];
  for (let i = 0; i < starvedCount; i++) {
    starved.push(view.getUint32(cur, true));
    cur += 4;
  }
  if (playheadCount > 256 || playheadCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: playheads overrun");
  const playheads = [];
  for (let i = 0; i < playheadCount; i++) {
    playheads.push(readStatusPlayheadsItem(view, cur));
    cur += 8;
  }
  if (clipEventCount > 64 || clipEventCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: clipEvents overrun");
  const clipEvents = [];
  for (let i = 0; i < clipEventCount; i++) {
    clipEvents.push(readStatusClipEventsItem(view, cur));
    cur += 8;
  }
  if (streamEventCount > 64 || streamEventCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: streamEvents overrun");
  const streamEvents = [];
  for (let i = 0; i < streamEventCount; i++) {
    streamEvents.push(readStatusStreamEventsItem(view, cur));
    cur += 8;
  }
  if (busCount > 32 || busCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: peaks overrun");
  const peaks = [];
  for (let i = 0; i < busCount; i++) {
    peaks.push(readStatusPeaksItem(view, cur));
    cur += 8;
  }
  if (bedsActive > 4 || bedsActive * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: beds overrun");
  const beds = [];
  for (let i = 0; i < bedsActive; i++) {
    beds.push(readStatusBedsItem(view, cur));
    cur += 8;
  }
  if (zoneSlots > 4 || zoneSlots * 12 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: zones overrun");
  const zones = [];
  for (let i = 0; i < zoneSlots; i++) {
    zones.push(readStatusZonesItem(view, cur));
    cur += 12;
  }
  if (zoneEventCount > 16 || zoneEventCount * 4 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: zoneEvents overrun");
  const zoneEvents = [];
  for (let i = 0; i < zoneEventCount; i++) {
    zoneEvents.push(readStatusZoneEventsItem(view, cur));
    cur += 4;
  }
  if (musicRingCount > 16 || musicRingCount * 8 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: musicRings overrun");
  const musicRings = [];
  for (let i = 0; i < musicRingCount; i++) {
    musicRings.push(readStatusMusicRingsItem(view, cur));
    cur += 8;
  }
  if (groupStartCount > 8 || groupStartCount * 16 > limit - cur) throw new WireError(ErrorCode.OVERSIZE, "STATUS: groupStarts overrun");
  const groupStarts = [];
  for (let i = 0; i < groupStartCount; i++) {
    groupStarts.push(readStatusGroupStartsItem(view, cur));
    cur += 16;
  }
  return { currentFrame, dateMs, pingSeq, pingFrameLo, underruns, lateCommands, workUnits, workUnitsMax, mixedVoices, liveVoices, flags, mixedCap, loadPermille, traps, minSlackFrames, underrunFrames, arenaUsedKB, arenaLargestFreeKB, abiVersion, maxLatenessFrames, hrtfVoices, hrtfLoadFailure, bedVoices, fxVoices, ambisonicVoices, zonesActive, zonesRinging, bedsRefused, m3Shed, zoneUsedKB, workBed, workZones, musicRingsOpen, streamStartsLate, groupsLate, groupsHeld, groupsAbandoned, curvePoolFull, maxSlipFrames, splitQuanta, voiceSplits, reserved, ended, demoted, starved, playheads, clipEvents, streamEvents, peaks, beds, zones, zoneEvents, musicRings, groupStarts };
}
var SCHEMA_HASH, MAGIC, VERSION_MAJOR, VERSION_MINOR, ASAP, BATCH_MAX_BYTES, STATUS_POOL_BUFFERS, STATUS_BUFFER_BYTES, STATUS_EVERY_QUANTA, STATUS_IDLE_EVERY_QUANTA, STATUS_IDLE_AFTER_MS, QUANTUM_FRAMES, STREAM_RING_FRAMES_WIDE, STREAM_WIDE_CHUNK_FRAMES, STREAM_MAX_CHANNELS, ZONE_KERNEL_HEADER_BYTES, ZONE_KERNEL_MAX_HEAD_PARTS, ZONE_HEAD_BINS, ZONE_TAIL_BINS, ErrorCode, WireError, Kind, ClipFormat, CLIP_BEGIN_FIXED_END, CLIP_CHUNK_FIXED_END, CLIP_UNLOAD_FIXED_END, STREAM_OPEN_FIXED_END, STREAM_CHUNK_FIXED_END, STREAM_CLOSE_FIXED_END, STREAM_CREDIT_FIXED_END, PLAY_FLAGS_LOOP, PLAY_FLAGS_MIXED, SET_PARAMS_MASK_BUS, STATUS_FLAGS_READY;
var init_wire_generated = __esm({
  "../../../../src/plugins/audio/runtime/wire.generated.ts"() {
    "use strict";
    SCHEMA_HASH = "287e5173cde33028cb09bd4bfbc4d2ec";
    MAGIC = 1297695025;
    VERSION_MAJOR = 1;
    VERSION_MINOR = 2;
    ASAP = 4294967295;
    BATCH_MAX_BYTES = 65536;
    STATUS_POOL_BUFFERS = 8;
    STATUS_BUFFER_BYTES = 16384;
    STATUS_EVERY_QUANTA = 6;
    STATUS_IDLE_EVERY_QUANTA = 48;
    STATUS_IDLE_AFTER_MS = 250;
    QUANTUM_FRAMES = 128;
    STREAM_RING_FRAMES_WIDE = 32768;
    STREAM_WIDE_CHUNK_FRAMES = 2048;
    STREAM_MAX_CHANNELS = 16;
    ZONE_KERNEL_HEADER_BYTES = 32;
    ZONE_KERNEL_MAX_HEAD_PARTS = 32;
    ZONE_HEAD_BINS = 128;
    ZONE_TAIL_BINS = 2048;
    ErrorCode = {
      NOT_IMPLEMENTED: -1,
      BAD_ARG: -2,
      BAD_MAGIC: -3,
      VERSION_MISMATCH: -4,
      TRUNCATED: -5,
      OVERSIZE: -6,
      BAD_STATE: -7,
      INBOX_OVERFLOW: -8,
      ARENA_FULL: -9,
      CEILING: -10,
      UNKNOWN_CLIP: -11,
      STALE_ID: -12,
      STALE_EPOCH: -13,
      UNKNOWN_STREAM: -14,
      BAD_FORMAT: -15,
      MALFORMED: -16
    };
    WireError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "WireError";
        this.code = code;
      }
    };
    Kind = {
      BATCH: 1,
      CLIP_BEGIN: 2,
      CLIP_CHUNK: 3,
      CLIP_UNLOAD: 4,
      STREAM_OPEN: 5,
      STREAM_CHUNK: 6,
      STREAM_CLOSE: 7,
      TIME_PING: 8,
      STATUS: 9,
      RECYCLE: 10,
      STREAM_CREDIT: 11,
      REPLAY: 12
    };
    ClipFormat = {
      F32: 0,
      I16: 1,
      HRIR: 2,
      ZoneKernel: 3,
      MagLS: 4,
      ZoneIrPcm: 5
    };
    CLIP_BEGIN_FIXED_END = 36;
    CLIP_CHUNK_FIXED_END = 32;
    CLIP_UNLOAD_FIXED_END = 20;
    STREAM_OPEN_FIXED_END = 56;
    STREAM_CHUNK_FIXED_END = 36;
    STREAM_CLOSE_FIXED_END = 20;
    STREAM_CREDIT_FIXED_END = 32;
    PLAY_FLAGS_LOOP = 1;
    PLAY_FLAGS_MIXED = 8;
    SET_PARAMS_MASK_BUS = 32;
    STATUS_FLAGS_READY = 16;
  }
});

// ../../../../src/plugins/audio/runtime/core/bufferPool.ts
function createStatusPool() {
  return new BufferPool(STATUS_POOL_BUFFERS, STATUS_BUFFER_BYTES);
}
function createBatchPool() {
  return new BufferPool(BATCH_POOL_BUFFERS, BATCH_MAX_BYTES);
}
var BATCH_POOL_BUFFERS, BufferPool;
var init_bufferPool = __esm({
  "../../../../src/plugins/audio/runtime/core/bufferPool.ts"() {
    "use strict";
    init_wire_generated();
    BATCH_POOL_BUFFERS = 4;
    BufferPool = class {
      /**
       * Allocates all `count` buffers up front (so `available === count`). `count` and `bytes` are positive integers;
       * anything else throws a `RangeError`.
       */
      constructor(count, bytes) {
        this.count = count;
        this.bytes = bytes;
        if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(bytes) || bytes <= 0) {
          throw new RangeError(`BufferPool needs a positive integer count and bytes (got ${count} and ${bytes})`);
        }
        this.free = [];
        for (let i = 0; i < count; i++) this.free.push(new ArrayBuffer(bytes));
        this.list = [new ArrayBuffer(0)];
      }
      count;
      bytes;
      /** The buffers not currently taken out; preallocated, so `acquire`/`release` never grow it past `count`. */
      free;
      /** The one transfer-list array, reused by every `transferList` call (§4.3). */
      list;
      /** How many buffers are in the pool now (0..count). */
      get available() {
        return this.free.length;
      }
      /** Takes a buffer out of the pool, or `null` when it's empty (the caller skips its post, §4.3). Never allocates. */
      acquire() {
        return this.free.pop() ?? null;
      }
      /**
       * Puts a buffer (back) into the pool and returns `true`. A buffer that came back through `postMessage` is a new
       * object, so any buffer of exactly `bytes` bytes is accepted. Returns `false` and keeps nothing when the buffer
       * is detached (byteLength 0), has another size, is already in the pool (the same object), or the pool already
       * holds `count` buffers.
       */
      release(buffer) {
        if (buffer.byteLength !== this.bytes) return false;
        if (this.free.length >= this.count) return false;
        for (const held of this.free) {
          if (held === buffer) return false;
        }
        this.free.push(buffer);
        return true;
      }
      /**
       * A transfer list holding just `buffer`, for `postMessage(buffer, list)`. The same array object every call
       * (§4.3: "a preallocated transfer-list array"), so posting allocates nothing; use it before the next call.
       */
      transferList(buffer) {
        this.list[0] = buffer;
        return this.list;
      }
    };
  }
});

// ../../../../src/plugins/audio/runtime/decoder/credit.ts
var STREAM_CREDIT_FRAMES, CreditAccumulator;
var init_credit = __esm({
  "../../../../src/plugins/audio/runtime/decoder/credit.ts"() {
    "use strict";
    STREAM_CREDIT_FRAMES = 4096;
    CreditAccumulator = class {
      constructor(every = STREAM_CREDIT_FRAMES) {
        this.every = every;
      }
      every;
      /** Consumed frames not yet credited. */
      pending = 0;
      /** The core reported `frames` more consumed. Returns true when a credit is due. */
      add(frames) {
        if (frames > 0) this.pending += frames;
        return this.pending >= this.every;
      }
      /** Takes what is pending (the credit's `consumedFrames`). */
      take() {
        const n = this.pending;
        this.pending = 0;
        return n;
      }
    };
  }
});

// ../../../../src/plugins/audio/runtime/worklet/coreDriver.ts
function bedPartitions(sampleRate) {
  const ratio = Math.fround(Math.fround(sampleRate) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  const fft = 2 * Math.max(2, 2 ** exponent);
  return Math.max(1, fft / 256);
}
function bedsRegionBytes(slots, sampleRate) {
  if (slots === 0) return 0;
  const p = bedPartitions(sampleRate);
  return BEDS_HEADER_BYTES + BEDS_SCRATCH_BYTES + (BEDS_FILTER_BYTES[p] ?? 0) + slots * (BEDS_SLOT_BYTES[p] ?? BEDS_ACC_ONLY_SLOT_BYTES);
}
function zoneKernelBlobBytes(frames) {
  return ZONE_KERNEL_HEADER_BYTES + 2 * headParts(frames) * ZONE_HEAD_BINS * 8 + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8;
}
function zoneKernelBudgetBytes(maxZoneSlots, zoneMaxFrames2) {
  return maxZoneSlots === 0 ? 0 : maxZoneSlots * arenaBlockBytes(zoneKernelBlobBytes(zoneMaxFrames2));
}
function arenaBlockBytes(bytes) {
  for (let d = 0; d < 20; d++) {
    for (let s = 0; s < 4; s++) {
      const block = 1024 * 2 ** d * (4 + s);
      if (block >= bytes) return block;
    }
  }
  return Infinity;
}
function zoneSlotStateBytes(frames) {
  const instance = 32 + 2 * (ZONE_KERNEL_MAX_HEAD_PARTS * ZONE_HEAD_BINS * 8 + QUANTUM * 4) + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8 + 2 * ZONE_TAIL_BINS * 8 + 2 * 8192 * 4 + 2 * 4096 * 4;
  return alignUp(ZONE_SLOT_HEADER_BYTES + instance, REGION_ALIGN);
}
function zonesRegionBytes(maxZoneSlots, zoneMaxFrames2, maxBuses) {
  const slots = maxZoneSlots > 0 ? maxZoneSlots * zoneSlotStateBytes(zoneMaxFrames2) : 0;
  return slots + maxBuses * 2 * QUANTUM * 4 + (REGION_ALIGN + maxBuses * QUANTUM * 4) + REGION_ALIGN;
}
function zoneMaxFrames(preset, sampleRate) {
  return preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate) : 0;
}
function spatialRegionsBytes(preset, sampleRate) {
  const beds = bedsRegionBytes(preset.maxBeds + preset.maxWide, sampleRate);
  const zones = zonesRegionBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate), preset.maxBuses);
  const wide = preset.maxWide * WIDE_RING_BYTES;
  const fx = alignUp(preset.maxMixed * FX_ENTRY_BYTES, REGION_ALIGN);
  return [beds, zones, wide, fx, PLANAR_SCRATCH_BYTES].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}
function fixedRegionsHeadroomBytes(preset, sampleRate) {
  return M2_REGIONS_HEADROOM_BYTES + spatialRegionsBytes(preset, sampleRate) + m4FixedRegionsBytes() + musicRingsBytes(preset) + zoneKernelBudgetBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate));
}
function m4FixedRegionsBytes() {
  return [18432, 8160, 2560].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}
function musicRingsBytes(preset) {
  return preset.maxMusicRings * 307200;
}
function clipSampleBytes(format) {
  switch (format) {
    case ClipFormat.F32:
    case ClipFormat.ZoneKernel:
    case ClipFormat.MagLS:
    case ClipFormat.ZoneIrPcm:
      return 4;
    case ClipFormat.I16:
    case ClipFormat.HRIR:
      return 2;
    default:
      return 0;
  }
}
function memoryMaximumPages(preset, sampleRate) {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((fixedRegionsHeadroomBytes(preset, sampleRate) + arena) / PAGE_BYTES));
}
function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function instantiateCore(wasm, preset, sampleRate, expected = EXPECTED) {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: memoryMaximumPages(preset, sampleRate) });
  let exports;
  try {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports;
  } catch (error) {
    throw new CoreLoadError(`audio core: instantiating myco_audio.wasm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const abi = exports.myco_audio_abi_version();
  if (abi >> 8 !== expected.abiMajor) throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 255} where ${expected.abiMajor}.x was expected`);
  const code = exports.myco_audio_init(
    sampleRate,
    preset.maxLogical,
    preset.maxMixed,
    preset.maxBuses,
    preset.arenaInitialBytes,
    preset.maxBeds,
    preset.maxZoneSlots,
    zoneMaxFrames(preset, sampleRate),
    preset.maxWide,
    preset.maxMusicRings
  );
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  if (typeof exports.myco_audio_set_limiter_lookahead !== "function") throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 255} lacks myco_audio_set_limiter_lookahead (1.1)`);
  const lookahead = exports.myco_audio_set_limiter_lookahead(preset.limiterLookaheadMs);
  if (lookahead !== 0) throw new CoreLoadError(`audio core: myco_audio_set_limiter_lookahead refused (code ${lookahead})`);
  return { exports, memory, sampleRate };
}
var CORE_ABI_MAJOR, MEMORY_INITIAL_PAGES, PAGE_BYTES, M2_REGIONS_HEADROOM_BYTES, MAX_PAGES, REGION_ALIGN, QUANTUM, BEDS_HEADER_BYTES, BEDS_SCRATCH_BYTES, BEDS_FILTER_BYTES, BEDS_SLOT_BYTES, BEDS_ACC_ONLY_SLOT_BYTES, FADE_TAIL_FRAMES, WIDE_RING_BYTES, FX_ENTRY_BYTES, PLANAR_SCRATCH_BYTES, alignUp, headParts, tailParts, ZONE_SLOT_HEADER_BYTES, CoreLoadError, EXPECTED, SHELL_FIELD, FLAG_TRAP_CAUGHT, PROBE_BUCKETS, PROBE_BUCKET_MS, PROBE_WARM_MS, PROBE_JUMP_MS, PROBE_THRESHOLD_S, PROBE_SAWTOOTH_COVERED_S, UnderrunProbe, CLIP_BYTES_PER_QUANTUM, OUTPUT_SAMPLES, TWO_PI, CoreDriver;
var init_coreDriver = __esm({
  "../../../../src/plugins/audio/runtime/worklet/coreDriver.ts"() {
    "use strict";
    init_bufferPool();
    init_credit();
    init_wire_generated();
    CORE_ABI_MAJOR = 3;
    MEMORY_INITIAL_PAGES = 64;
    PAGE_BYTES = 65536;
    M2_REGIONS_HEADROOM_BYTES = 16 << 20;
    MAX_PAGES = 65536;
    REGION_ALIGN = 64;
    QUANTUM = 128;
    BEDS_HEADER_BYTES = 20800;
    BEDS_SCRATCH_BYTES = 33792;
    BEDS_FILTER_BYTES = { 2: 65600, 4: 131136 };
    BEDS_SLOT_BYTES = { 2: 49216, 4: 81984 };
    BEDS_ACC_ONLY_SLOT_BYTES = 8192;
    FADE_TAIL_FRAMES = 1536;
    WIDE_RING_BYTES = STREAM_MAX_CHANNELS * (STREAM_RING_FRAMES_WIDE + STREAM_WIDE_CHUNK_FRAMES + FADE_TAIL_FRAMES) * 4;
    FX_ENTRY_BYTES = 448;
    PLANAR_SCRATCH_BYTES = 16 * QUANTUM * 4;
    alignUp = (n, to) => Math.ceil(n / to) * to;
    headParts = (frames) => Math.min(Math.ceil(frames / QUANTUM), ZONE_KERNEL_MAX_HEAD_PARTS);
    tailParts = (frames) => Math.ceil(Math.max(0, frames - ZONE_KERNEL_MAX_HEAD_PARTS * QUANTUM) / ZONE_TAIL_BINS);
    ZONE_SLOT_HEADER_BYTES = 2208;
    CoreLoadError = class extends Error {
      name = "CoreLoadError";
    };
    EXPECTED = { schemaHash: SCHEMA_HASH, abiMajor: CORE_ABI_MAJOR };
    SHELL_FIELD = {
      dateMs: 24,
      pingSeq: 32,
      pingFrameLo: 36,
      underruns: 40,
      flags: 60,
      traps: 82,
      underrunFrames: 88
    };
    FLAG_TRAP_CAUGHT = 1 << 5;
    PROBE_BUCKETS = 8;
    PROBE_BUCKET_MS = 125;
    PROBE_WARM_MS = 1e3;
    PROBE_JUMP_MS = 500;
    PROBE_THRESHOLD_S = 0.024;
    PROBE_SAWTOOTH_COVERED_S = 0.012;
    UnderrunProbe = class {
      constructor(sampleRate) {
        this.sampleRate = sampleRate;
      }
      sampleRate;
      underruns = 0;
      underrunFrames = 0;
      anchored = false;
      t0 = 0;
      f0 = 0;
      warmUntil = 0;
      lastDate = 0;
      buckets = new Float64Array(PROBE_BUCKETS);
      /** Which 125 ms slot each bucket holds, so a stale bucket resets before it's reused. */
      bucketSlot = new Float64Array(PROBE_BUCKETS);
      /** F-37: each bucket's lag spread (min and max of the lag) and its slot, kept across anchors; a scratch for the median. */
      spreadMin = new Float64Array(PROBE_BUCKETS);
      spreadMax = new Float64Array(PROBE_BUCKETS);
      spreadSlot = new Float64Array(PROBE_BUCKETS).fill(-1);
      spreads = new Float64Array(PROBE_BUCKETS);
      /** (Re)anchors at this call: on start, resume, becoming visible and rebuild. */
      anchor(currentFrame, dateNow) {
        this.anchored = true;
        this.t0 = dateNow;
        this.f0 = currentFrame;
        this.warmUntil = dateNow + PROBE_WARM_MS;
        this.lastDate = dateNow;
        this.buckets.fill(Infinity);
        this.bucketSlot.fill(-1);
        const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
        if (this.spreadSlot[slot % PROBE_BUCKETS] === slot) this.spreadSlot[slot % PROBE_BUCKETS] = -1;
      }
      /** F-37: the device's sawtooth in frames: the median lag spread of the last second's complete buckets (0 before one). */
      sawtoothFrames(dateNow) {
        const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
        const spreads = this.spreads;
        let n = 0;
        for (let i = 0; i < PROBE_BUCKETS; i++) {
          const s = this.spreadSlot[i];
          const complete = s >= 0 && s < slot && s >= slot - PROBE_BUCKETS;
          spreads[i] = complete ? this.spreadMax[i] - this.spreadMin[i] : Infinity;
          if (complete) n++;
        }
        if (n === 0) return 0;
        spreads.sort();
        return spreads[n - 1 >> 1];
      }
      /** One `process()` call: `currentFrame` is the first frame of the quantum about to render. */
      step(currentFrame, dateNow) {
        if (!this.anchored || dateNow < this.lastDate || dateNow - this.lastDate > PROBE_JUMP_MS) {
          this.anchor(currentFrame, dateNow);
          return;
        }
        this.lastDate = dateNow;
        const d = (dateNow - this.t0) * this.sampleRate / 1e3 - (currentFrame + QUANTUM_FRAMES - this.f0);
        const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
        const b = slot % PROBE_BUCKETS;
        if (this.bucketSlot[b] !== slot) {
          this.bucketSlot[b] = slot;
          this.buckets[b] = Infinity;
        }
        if (d < this.buckets[b]) this.buckets[b] = d;
        if (this.spreadSlot[b] !== slot) {
          this.spreadSlot[b] = slot;
          this.spreadMin[b] = d;
          this.spreadMax[b] = d;
        } else if (d < this.spreadMin[b]) this.spreadMin[b] = d;
        else if (d > this.spreadMax[b]) this.spreadMax[b] = d;
        if (dateNow < this.warmUntil) return;
        let dMin = Infinity;
        for (let i = 0; i < PROBE_BUCKETS; i++) if (this.buckets[i] < dMin) dMin = this.buckets[i];
        const lag = d - dMin;
        const threshold = PROBE_THRESHOLD_S * this.sampleRate;
        if (lag <= threshold) return;
        const allowance = Math.max(0, this.sawtoothFrames(dateNow) - PROBE_SAWTOOTH_COVERED_S * this.sampleRate);
        if (lag > threshold + allowance) {
          this.underruns = this.underruns + 1 >>> 0;
          this.underrunFrames = this.underrunFrames + Math.round(lag) >>> 0;
          this.anchor(currentFrame, dateNow);
        }
      }
    };
    CLIP_BYTES_PER_QUANTUM = 256 * 1024;
    OUTPUT_SAMPLES = 2 * QUANTUM_FRAMES;
    TWO_PI = 2 * Math.PI;
    CoreDriver = class {
      /** `dateNow` is the wall clock at construction: the idle cadence counts 250 ms from it until a batch arrives. */
      constructor(core, post, dateNow) {
        this.core = core;
        this.post = post;
        this.probe = new UnderrunProbe(core.sampleRate);
        this.lastBatchDate = dateNow;
        this.u8 = new Uint8Array(core.memory.buffer);
        this.f32 = new Float32Array(core.memory.buffer);
      }
      core;
      post;
      stats = { quanta: 0, posted: 0, skipped: 0, recycled: 0, returned: 0, clipBytes: 0, streamFrames: 0, streamRefused: 0, streamCredits: 0 };
      /** The STATUS pool (§4.3: 8 × 16 KB). */
      pool = createStatusPool();
      /** The underrun probe (§4.7); its counts go into every STATUS. */
      probe;
      /** The planar output `process` returns, and its two channels as views (no allocation per call). */
      output = new Float32Array(OUTPUT_SAMPLES);
      left = this.output.subarray(0, QUANTUM_FRAMES);
      right = this.output.subarray(QUANTUM_FRAMES, OUTPUT_SAMPLES);
      /** Traps caught; sent in STATUS `traps`. */
      traps = 0;
      /** The probe's underrun total as last told to the core (A3.3's adaptive cap). */
      notedUnderruns = 0;
      /**
       * True once the core trapped (A3.4a): a trapped instance is left mid-call (its stack pointer and any half-written
       * state are unknown), so the shell never calls it again. It renders silence, posts no STATUS, returns every buffer
       * and drops clip messages until the host replaces the node (the hard rebuild, architecture §3.6).
       */
      dead = false;
      pingSeq = 0;
      pingFrameLo = 0;
      lastBatchDate;
      sinceStatus = 0;
      toneStep = 0;
      toneGain = 0;
      tonePhase = 0;
      u8;
      f32;
      /** Reserved clips by id (CLIP_BEGIN accepted, no CLIP_UNLOAD yet). */
      clips = /* @__PURE__ */ new Map();
      /** Clip messages waiting for this quantum's copy budget, in arrival order. */
      clipQueue = [];
      clipBudget = CLIP_BYTES_PER_QUANTUM;
      /** B3: open streams by id, and where credits go (null until the host connects the worker's port). */
      streams = /* @__PURE__ */ new Map();
      streamPost = null;
      /** ADR 0162 C9: zone kernels (format 3 clips) the decoder worker sent on the stream port and hasn't unloaded. */
      portKernels = /* @__PURE__ */ new Set();
      /** Re-creates the memory views when memory grew (growth detaches them; api-and-models §5 "Ownership"). */
      views() {
        if (this.u8.buffer !== this.core.memory.buffer) {
          this.u8 = new Uint8Array(this.core.memory.buffer);
          this.f32 = new Float32Array(this.core.memory.buffer);
        }
      }
      giveBack(buffer) {
        this.stats.returned++;
        this.post(buffer, [buffer]);
      }
      /**
       * A buffer from the host (api-and-models §4.1). TIME_PING: remember `pingSeq` and the low 32 bits of
       * `currentFrame`, echoed in every later STATUS. RECYCLE: back into the STATUS pool. BATCH or REPLAY: note the
       * time (the idle cadence), submit it and return it. CLIP_BEGIN, CLIP_CHUNK and CLIP_UNLOAD: into the clip queue
       * (reserve, chunk copy and commit, free; at most 256 KB copied per quantum), not returned. Anything else,
       * unreadable buffers included, is returned to the host untouched.
       */
      onMessage(buffer, currentFrame, dateNow) {
        if (buffer.byteLength < 16) return this.giveBack(buffer);
        const view = new DataView(buffer);
        if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return this.giveBack(buffer);
        const kind = view.getUint16(6, true);
        if (this.dead) {
          if (kind === Kind.RECYCLE) {
            if (this.pool.release(buffer)) this.stats.recycled++;
          } else if (kind !== Kind.CLIP_BEGIN && kind !== Kind.CLIP_CHUNK && kind !== Kind.CLIP_UNLOAD) this.giveBack(buffer);
          return;
        }
        switch (kind) {
          case Kind.RECYCLE:
            if (this.pool.release(buffer)) this.stats.recycled++;
            return;
          case Kind.TIME_PING:
            if (buffer.byteLength >= 20) {
              this.pingSeq = view.getUint32(16, true);
              this.pingFrameLo = currentFrame % 4294967296 >>> 0;
            }
            return this.giveBack(buffer);
          case Kind.BATCH:
          case Kind.REPLAY: {
            this.lastBatchDate = dateNow;
            const len = 16 + view.getUint32(12, true);
            const { exports } = this.core;
            if (len <= buffer.byteLength && len <= exports.myco_audio_inbox_cap()) {
              this.views();
              this.u8.set(new Uint8Array(buffer, 0, len), exports.myco_audio_inbox_ptr());
              exports.myco_audio_submit(len);
            }
            return this.giveBack(buffer);
          }
          case Kind.CLIP_BEGIN:
          case Kind.CLIP_CHUNK:
          case Kind.CLIP_UNLOAD:
            this.clipQueue.push(buffer);
            this.drainClips();
            return;
          default:
            return this.giveBack(buffer);
        }
      }
      /** Clip messages still waiting for a quantum's copy budget. */
      get pendingClipMessages() {
        return this.clipQueue.length;
      }
      /**
       * Applies queued clip messages in order while this quantum's budget (`CLIP_BYTES_PER_QUANTUM`) lasts; `process`
       * resets the budget and drains again. The main side already paces its chunks to the same budget, so the queue is
       * normally empty. Clip buffers aren't returned: the main side allocates each one (A1.3a's registry), and none
       * belongs to the host's BATCH pool.
       */
      drainClips() {
        while (this.clipQueue.length > 0 && !this.dead) {
          const buffer = this.clipQueue[0];
          const view = new DataView(buffer);
          const kind = view.getUint16(6, true);
          if (kind === Kind.CLIP_CHUNK) {
            const bytes = this.chunkBytes(view);
            if (bytes > this.clipBudget && this.clipBudget < CLIP_BYTES_PER_QUANTUM) return;
            this.clipBudget -= Math.min(bytes, this.clipBudget);
          }
          this.clipQueue.shift();
          if (kind === Kind.CLIP_BEGIN) this.clipBegin(view);
          else if (kind === Kind.CLIP_CHUNK) this.clipChunk(view);
          else this.clipUnload(view);
        }
      }
      /** A chunk's sample bytes: `frames * channels * bytesPerSample`, never the (padded) body size; 0 when unusable. */
      chunkBytes(view) {
        if (view.byteLength < CLIP_CHUNK_FIXED_END) return 0;
        const chunk = readClipChunk(view, 0);
        const shape = this.clips.get(chunk.clipId);
        return shape ? chunk.frames * shape.frameBytes : 0;
      }
      /** CLIP_BEGIN → `myco_audio_clip_reserve` (may grow memory: the views are re-created before the next copy). */
      clipBegin(view) {
        if (view.byteLength < CLIP_BEGIN_FIXED_END) return;
        const begin = readClipBegin(view, 0);
        const code = this.core.exports.myco_audio_clip_reserve(begin.clipId, begin.frames, begin.channels, begin.sampleRate, begin.format);
        this.views();
        if (code === 0) this.clips.set(begin.clipId, { frameBytes: begin.channels * clipSampleBytes(begin.format) });
      }
      /** CLIP_CHUNK → `clip_chunk_ptr`, one copy from the message, `clip_commit`; the last range makes the clip resident. */
      clipChunk(view) {
        const bytes = this.chunkBytes(view);
        if (bytes === 0 || CLIP_CHUNK_FIXED_END + bytes > view.byteLength) return;
        const chunk = readClipChunk(view, 0);
        const { exports } = this.core;
        const ptr = exports.myco_audio_clip_chunk_ptr(chunk.clipId, chunk.frameOffset, bytes);
        if (ptr === 0) return;
        this.views();
        this.u8.set(new Uint8Array(view.buffer, CLIP_CHUNK_FIXED_END, bytes), ptr);
        if (exports.myco_audio_clip_commit(chunk.clipId, chunk.frameOffset, bytes) === 0) this.stats.clipBytes += bytes;
      }
      /** CLIP_UNLOAD → `myco_audio_clip_free`. */
      clipUnload(view) {
        if (view.byteLength < CLIP_UNLOAD_FIXED_END) return;
        const { clipId } = readClipUnload(view, 0);
        this.clips.delete(clipId);
        this.core.exports.myco_audio_clip_free(clipId);
      }
      // --- Streams (B3) ---------------------------------------------------------------------------------------
      /** B3: where STREAM_CREDITs go: the worker's port (the processor wires `streamPort`), or a fake in tests. */
      setStreamPost(post) {
        if (this.streamPost && post && post !== this.streamPost) {
          this.closeAllStreams();
          this.unloadPortKernels();
        }
        this.streamPost = post;
      }
      /** CLIP_UNLOAD, queued behind what is waiting, for every kernel the worker's port brought. */
      unloadPortKernels() {
        for (const clipId of this.portKernels) {
          const buffer = new ArrayBuffer(CLIP_UNLOAD_FIXED_END);
          const view = new DataView(buffer);
          writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: 0, bodyBytes: CLIP_UNLOAD_FIXED_END - 16 });
          writeClipUnload(view, 0, { clipId });
          this.clipQueue.push(buffer);
        }
        this.portKernels.clear();
        this.drainClips();
      }
      /** Zone kernels the decoder worker's port brought that are still loaded or loading (for tests). */
      get workerClips() {
        return this.portKernels.size;
      }
      /** STREAM_CLOSE for every open stream, through the inbox as the worker's would come. */
      closeAllStreams() {
        if (this.dead) return this.streams.clear();
        for (const streamId of [...this.streams.keys()]) {
          const buffer = new ArrayBuffer(STREAM_CLOSE_FIXED_END);
          const view = new DataView(buffer);
          writeEnvelope(view, 0, { kind: Kind.STREAM_CLOSE, seq: 0, bodyBytes: STREAM_CLOSE_FIXED_END - 16 });
          writeStreamClose(view, 0, { streamId });
          this.submitSmall(buffer);
        }
        this.streams.clear();
      }
      /** Open streams (for tests). */
      get openStreams() {
        return this.streams.size;
      }
      /**
       * B3: a message from the decoder worker. STREAM_OPEN and STREAM_CLOSE go into the inbox (`myco_audio_submit`);
       * STREAM_CHUNK is copied straight into its ring and its buffer kept for the next credit. ADR 0162 C9: the worker's
       * zone kernels, CLIP_BEGIN format 3 then CLIP_CHUNKs (and CLIP_UNLOAD when released), join the clip queue as main's
       * clips do (`drainClips`, `CLIP_BYTES_PER_QUANTUM` per quantum); no other clip format, and no clip the port didn't
       * begin, is taken from it. A dead (trapped) core takes nothing; anything unreadable is dropped.
       */
      onStreamMessage(data, currentFrame, dateNow) {
        void currentFrame;
        void dateNow;
        if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || this.dead) return;
        const view = new DataView(data);
        if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return;
        switch (view.getUint16(6, true)) {
          case Kind.STREAM_OPEN: {
            if (data.byteLength < STREAM_OPEN_FIXED_END) return;
            const open = readStreamOpen(view, 0);
            if (open.channels < 1 || open.channels > STREAM_MAX_CHANNELS) return;
            if (this.submitSmall(data) !== 0) return;
            const known = this.streams.get(open.streamId);
            if (known) {
              known.channels = open.channels;
              known.epoch = open.epoch;
              known.credit.take();
            } else this.streams.set(open.streamId, { channels: open.channels, epoch: open.epoch, credit: new CreditAccumulator(), returned: [] });
            return;
          }
          case Kind.STREAM_CHUNK:
            return this.streamChunk(view);
          case Kind.CLIP_BEGIN: {
            if (data.byteLength < CLIP_BEGIN_FIXED_END) return;
            const begin = readClipBegin(view, 0);
            if (begin.format !== ClipFormat.ZoneKernel) return;
            this.portKernels.add(begin.clipId);
            this.clipQueue.push(data);
            return this.drainClips();
          }
          case Kind.CLIP_CHUNK:
          case Kind.CLIP_UNLOAD: {
            const kind = view.getUint16(6, true);
            if (data.byteLength < (kind === Kind.CLIP_CHUNK ? CLIP_CHUNK_FIXED_END : CLIP_UNLOAD_FIXED_END)) return;
            const clipId = kind === Kind.CLIP_CHUNK ? readClipChunk(view, 0).clipId : readClipUnload(view, 0).clipId;
            if (!this.portKernels.has(clipId)) return;
            if (kind === Kind.CLIP_UNLOAD) this.portKernels.delete(clipId);
            this.clipQueue.push(data);
            return this.drainClips();
          }
          case Kind.STREAM_CLOSE: {
            if (data.byteLength < STREAM_CLOSE_FIXED_END) return;
            const { streamId } = readStreamClose(view, 0);
            this.submitSmall(data);
            const shape = this.streams.get(streamId);
            this.streams.delete(streamId);
            if (shape && shape.returned.length > 0) this.postCredit(streamId, shape, 0);
            return;
          }
          default:
            return;
        }
      }
      /** A small control message through the inbox; returns `myco_audio_submit`'s code. */
      submitSmall(buffer) {
        const len = 16 + new DataView(buffer).getUint32(12, true);
        const { exports } = this.core;
        if (len > buffer.byteLength || len > exports.myco_audio_inbox_cap()) return -1;
        this.views();
        this.u8.set(new Uint8Array(buffer, 0, len), exports.myco_audio_inbox_ptr());
        return exports.myco_audio_submit(len);
      }
      /** STREAM_CHUNK → `stream_chunk_ptr`, one copy, `stream_commit`. The buffer goes back with the stream's next credit. */
      streamChunk(view) {
        if (view.byteLength < STREAM_CHUNK_FIXED_END) return;
        const chunk = readStreamChunk(view, 0);
        const shape = this.streams.get(chunk.streamId);
        const buffer = view.buffer;
        if (!shape) {
          this.stats.streamRefused++;
          this.postBuffers([buffer], chunk.streamId, chunk.epoch);
          return;
        }
        shape.returned.push(buffer);
        const bytes = chunk.frames * shape.channels * 4;
        if (STREAM_CHUNK_FIXED_END + bytes > view.byteLength || chunk.epoch !== shape.epoch) {
          this.stats.streamRefused++;
          return;
        }
        const { exports } = this.core;
        if (chunk.frames > 0) {
          const ptr = exports.myco_audio_stream_chunk_ptr(chunk.streamId, chunk.frames);
          if (ptr === 0) {
            this.stats.streamRefused++;
            return;
          }
          this.views();
          this.u8.set(new Uint8Array(buffer, STREAM_CHUNK_FIXED_END, bytes), ptr);
        }
        if (exports.myco_audio_stream_commit(chunk.streamId, chunk.frames, chunk.epoch, chunk.flags) === 0) this.stats.streamFrames += chunk.frames;
        else this.stats.streamRefused++;
      }
      /** After a quantum: what each stream consumed; a credit every 4,096 frames (`credit.ts`). */
      creditStreams() {
        const consumed = this.core.exports.myco_audio_stream_consumed;
        if (typeof consumed !== "function" || this.streams.size === 0) return;
        for (const [id, shape] of this.streams) {
          const n = consumed(id);
          if (n > 0 && shape.credit.add(n)) this.postCredit(id, shape, shape.credit.take());
        }
      }
      /** STREAM_CREDIT for `frames`, written into the first returned buffer (a small new one if none), the rest after it. */
      postCredit(id, shape, frames) {
        const buffers = shape.returned.splice(0);
        this.postBuffers(buffers, id, shape.epoch, frames);
      }
      postBuffers(buffers, streamId, epoch, consumedFrames = 0) {
        const post = this.streamPost;
        if (!post) return;
        const head = buffers.length > 0 && buffers[0].byteLength >= STREAM_CREDIT_FIXED_END ? buffers[0] : new ArrayBuffer(STREAM_CREDIT_FIXED_END);
        if (head !== buffers[0]) buffers.unshift(head);
        const view = new DataView(head);
        writeEnvelope(view, 0, { kind: Kind.STREAM_CREDIT, seq: 0, bodyBytes: STREAM_CREDIT_FIXED_END - 16 });
        writeStreamCredit(view, 0, { streamId, epoch, consumedFrames, returnedBuffers: buffers.length - 1 });
        this.stats.streamCredits++;
        post(buffers, buffers);
      }
      /** A dev-only control (`debugTone`). */
      onControl(message) {
        if (message.type !== "debugTone") return;
        const on = message.hz > 0 && message.gain > 0;
        this.toneStep = on ? TWO_PI * message.hz / this.core.sampleRate : 0;
        this.toneGain = on ? Math.min(message.gain, 1) : 0;
      }
      /**
       * Renders the quantum starting at `currentFrame` and returns the planar stereo output, `[L; 128][R; 128]`, in a
       * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`, posts
       * one `trap` event (the host rebuilds, A3.4a) and leaves the driver `dead`: silence from then on, with no call into
       * the core. Posts STATUS at its cadence while alive.
       */
      process(currentFrame, dateNow) {
        this.stats.quanta++;
        if (this.dead) {
          this.output.fill(0);
          return this.output;
        }
        this.probe.step(currentFrame, dateNow);
        if (this.probe.underruns !== this.notedUnderruns) this.noteUnderruns();
        if (this.dead) {
          this.output.fill(0);
          return this.output;
        }
        this.clipBudget = CLIP_BYTES_PER_QUANTUM;
        if (this.clipQueue.length > 0) this.drainClips();
        let ptr = 0;
        try {
          ptr = this.core.exports.myco_audio_process(currentFrame % 4294967296 >>> 0, Math.floor(currentFrame / 4294967296));
        } catch (error) {
          this.trapped(error);
          this.output.fill(0);
          return this.output;
        }
        if (ptr !== 0) {
          this.views();
          const at = ptr >>> 2;
          this.output.set(this.f32.subarray(at, at + OUTPUT_SAMPLES));
        } else {
          this.output.fill(0);
        }
        if (this.toneGain > 0) this.addTone();
        this.creditStreams();
        const every = dateNow - this.lastBatchDate > STATUS_IDLE_AFTER_MS ? STATUS_IDLE_EVERY_QUANTA : STATUS_EVERY_QUANTA;
        if (++this.sinceStatus >= every) {
          this.sinceStatus = 0;
          this.postStatus(dateNow);
        }
        return this.output;
      }
      /** A3.3: the core's adaptive cap drops on an underrun, so the probe's new total goes to it before this quantum renders. */
      noteUnderruns() {
        this.notedUnderruns = this.probe.underruns;
        try {
          this.core.exports.myco_audio_note_underruns?.(this.probe.underruns);
        } catch (error) {
          this.trapped(error);
        }
      }
      /** The first trap: count it, mark the driver dead, drop queued clip messages and tell the host once. */
      trapped(error) {
        if (this.dead) return;
        this.dead = true;
        this.traps++;
        this.clipQueue.length = 0;
        this.streams.clear();
        this.portKernels.clear();
        this.toneGain = 0;
        this.post({ type: "trap", message: error instanceof Error ? error.message : String(error) });
      }
      addTone() {
        let phase = this.tonePhase;
        for (let i = 0; i < QUANTUM_FRAMES; i++) {
          const s = this.toneGain * Math.sin(phase);
          this.left[i] += s;
          this.right[i] += s;
          phase += this.toneStep;
          if (phase > TWO_PI) phase -= TWO_PI;
        }
        this.tonePhase = phase;
      }
      /** §4.3: only with a pooled buffer in hand is the block taken, so a skipped post keeps the core's queues. */
      postStatus(dateNow) {
        const buffer = this.pool.acquire();
        if (!buffer) {
          this.stats.skipped++;
          return;
        }
        const { exports } = this.core;
        let n = 0;
        try {
          n = exports.myco_audio_status_take();
        } catch (error) {
          this.trapped(error);
        }
        if (this.dead || n <= 0 || n > buffer.byteLength) {
          this.pool.release(buffer);
          return;
        }
        this.views();
        const ptr = exports.myco_audio_status_ptr();
        new Uint8Array(buffer, 0, n).set(this.u8.subarray(ptr, ptr + n));
        const view = new DataView(buffer);
        view.setFloat64(SHELL_FIELD.dateMs, dateNow, true);
        view.setUint32(SHELL_FIELD.pingSeq, this.pingSeq, true);
        view.setUint32(SHELL_FIELD.pingFrameLo, this.pingFrameLo, true);
        view.setUint32(SHELL_FIELD.underruns, this.probe.underruns, true);
        view.setUint32(SHELL_FIELD.underrunFrames, this.probe.underrunFrames, true);
        view.setUint16(SHELL_FIELD.traps, Math.min(this.traps, 65535), true);
        if (this.traps > 0) view.setUint32(SHELL_FIELD.flags, view.getUint32(SHELL_FIELD.flags, true) | FLAG_TRAP_CAUGHT, true);
        this.stats.posted++;
        this.post(buffer, this.pool.transferList(buffer));
      }
    };
  }
});

// ../../../../src/engine/core/graphics.ts
function detectPlatform(env = globalThis) {
  if ("__TAURI_INTERNALS__" in env) return "desktop";
  const ua = env.navigator?.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "mobile";
  if (/Macintosh/.test(ua) && (env.navigator?.maxTouchPoints ?? 0) > 1) return "mobile";
  return "web";
}

// ../../../../src/engine/audio/musicFormat.ts
var MUSIC_NODE_TYPES = ["segment", "playlist", "musicSwitch"];

// ../../../../src/engine/audio/eventFormat.ts
var NODE_TYPES = ["clip", "random", "sequence", "switch", "blend", "layer", "sustain"];
var EVENT_NODE_TYPES = [...NODE_TYPES, ...MUSIC_NODE_TYPES];

// ../../../../src/engine/audio/occlusionMaterials.ts
var DEFAULT_MATERIAL_NAME = "concrete";
var BUILTIN_MATERIALS = [
  { name: "none", transmissionDb: 0, cutoffHz: 22e3, wetOcclusion: 1 },
  { name: "cloth", transmissionDb: -4, cutoffHz: 8e3, wetOcclusion: 0.3 },
  { name: "glass", transmissionDb: -8, cutoffHz: 5e3, wetOcclusion: 0.4 },
  { name: "wood", transmissionDb: -12, cutoffHz: 2500, wetOcclusion: 0.5 },
  { name: "metal", transmissionDb: -25, cutoffHz: 1200, wetOcclusion: 0.6 },
  { name: "concrete", transmissionDb: -30, cutoffHz: 800, wetOcclusion: 0.6 }
];
var builtinMaterials = () => BUILTIN_MATERIALS.map((m) => ({ ...m }));
var CUTOFF_OPEN_HZ = 22e3;
var OPEN_LOG = Math.log(CUTOFF_OPEN_HZ);

// ../../../../src/engine/audio/settings.ts
var DEFAULT_MUSIC_RINGS = 12;
var DEFAULT_BED_MAX_BEDS = 2;
var DEFAULT_AMBISONIC_MAX_CLIPS = 1;
var DEFAULT_OCCLUSION_BUDGET_MS = 0.25;
var DEFAULT_OCCLUSION_SMOOTHING_MS = 100;
var DEFAULT_ZONES = { maxActive: 2, standby: 1, maxIrSeconds: 2 };
var DEFAULT_DOPPLER_MAX_SPEED = 150;
var DEFAULT_SPEED_OF_SOUND = 343;
var MASTER = "Master";
var defaultBuses = () => [MASTER, "Music", "SFX", "UI", "Voice"].map((name, i) => ({ name, ...i > 0 ? { parent: MASTER } : {}, volume: 1, mute: false, effects: [] }));
var DEFAULT_BACKEND = "core";
var MACOS_DESKTOP_DEFAULT_BACKEND = "babylon";
function isMacOSDesktop(env = globalThis) {
  if (detectPlatform(env) !== "desktop") return false;
  const nav = env.navigator;
  if ((nav?.maxTouchPoints ?? 0) > 1 || /iPhone|iPad|iPod/i.test(nav?.userAgent ?? "")) return false;
  return /mac/i.test(nav?.userAgentData?.platform ?? "") || /^mac/i.test(nav?.platform ?? "") || /Macintosh|Mac OS X/.test(nav?.userAgent ?? "");
}
function defaultBackend(env) {
  return isMacOSDesktop(env) ? MACOS_DESKTOP_DEFAULT_BACKEND : DEFAULT_BACKEND;
}
var DEFAULT_VOICES = { mixed: 128, logical: 4096, hrtf: 8 };
var DEFAULT_LIMITER_LOOKAHEAD_MS = 1.5;
var defaultAudioSettings = () => ({
  buses: defaultBuses(),
  snapshots: [],
  ducking: [],
  parameters: [],
  automation: [],
  voices: { ...DEFAULT_VOICES },
  background: "mute",
  clipFormat: "i16",
  codecs: { aac: false },
  spatial: "hrtf",
  backend: defaultBackend(),
  limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS,
  bed: { maxBeds: DEFAULT_BED_MAX_BEDS },
  ambisonic: { maxClips: DEFAULT_AMBISONIC_MAX_CLIPS },
  occlusion: { layers: null, budgetMs: DEFAULT_OCCLUSION_BUDGET_MS, defaultMaterial: DEFAULT_MATERIAL_NAME, smoothingMs: DEFAULT_OCCLUSION_SMOOTHING_MS, materials: builtinMaterials() },
  zones: { ...DEFAULT_ZONES },
  doppler: { maxSpeed: DEFAULT_DOPPLER_MAX_SPEED },
  speedOfSound: DEFAULT_SPEED_OF_SOUND,
  music: { rings: DEFAULT_MUSIC_RINGS },
  rhythmMode: false
});

// ../../../../src/engine/audio/mixer.ts
var OFF_HZ = 24e3;
var Bus = class {
  /** @internal */
  constructor(mixer2, name) {
    this.mixer = mixer2;
    this.name = name;
  }
  mixer;
  name;
  get s() {
    return this.mixer._state(this.name);
  }
  /** Whether the project has a bus with this name. */
  get exists() {
    return this.s !== void 0;
  }
  /** Linear gain, 0..2 (1 = as authored). */
  get volume() {
    return this.s?.volume ?? 0;
  }
  set volume(v) {
    const s = this.s;
    if (s) {
      s.volume = Math.min(2, Math.max(0, Number.isFinite(v) ? v : 0));
      this.mixer._dirty();
    }
  }
  get mute() {
    return this.s?.mute ?? false;
  }
  set mute(m) {
    const s = this.s;
    if (s) {
      s.mute = m;
      this.mixer._dirty();
    }
  }
  /** While any bus is soloed, only soloed buses (and the buses they feed and pass through) are heard. */
  get solo() {
    return this.s?.solo ?? false;
  }
  set solo(m) {
    const s = this.s;
    if (s) {
      s.solo = m;
      this.mixer._dirty();
    }
  }
  /** Sounds playing on this bus right now. */
  get activeVoices() {
    return this.s?.voices ?? 0;
  }
  /** The newest peak level on this bus (max of L and R, linear, decayed for display); 0 while the audio is locked. Declared by A1.6 (K10); fed by the core backend from STATUS (0 on the Babylon backend). */
  get peak() {
    return this.s?.peak ?? 0;
  }
  /** The level reaching the speakers from this bus (all gains up the tree multiplied). */
  get effectiveGain() {
    return (this.mixer.resolve(this.name)?.effectiveGain ?? 0) * this.mixer._viewChain(this.name);
  }
  /** Ease the volume to `v` over `seconds`. */
  fadeTo(v, seconds) {
    this.mixer._fade(this.name, v, seconds);
  }
};
var Mixer = class {
  buses = /* @__PURE__ */ new Map();
  order = [];
  settings = defaultAudioSettings();
  listeners = /* @__PURE__ */ new Set();
  changed = true;
  snapshotName = null;
  snapFade = 0;
  fades = /* @__PURE__ */ new Map();
  warned = /* @__PURE__ */ new Set();
  constructor(settings = defaultAudioSettings()) {
    this.configure(settings);
  }
  /** Replace the bus tree (project load). Script-set volumes reset to the project's. */
  configure(settings) {
    this.settings = settings;
    this.buses.clear();
    this.fades.clear();
    this.snapshotName = null;
    this.order = settings.buses.map((b) => b.name);
    for (const b of settings.buses) {
      this.buses.set(b.name, { settings: b, volume: b.volume, mute: b.mute, solo: false, snap: 1, snapFrom: 1, snapTo: 1, lp: OFF_HZ, lpFrom: OFF_HZ, lpTo: OFF_HZ, duck: 1, voices: 0, peak: 0, autoGain: 1, autoLp: OFF_HZ, viewGain: 1 });
    }
    this._dirty();
  }
  /** The project's audio settings this mixer was configured with (the backend selector, K3, reads `backend` from it). */
  get audioSettings() {
    return this.settings;
  }
  get busNames() {
    return this.order;
  }
  get currentSnapshot() {
    return this.snapshotName;
  }
  get snapshotNames() {
    return this.settings.snapshots.map((s) => s.name);
  }
  /** @internal */
  _state(name) {
    return this.buses.get(name);
  }
  /** @internal */
  _dirty() {
    this.changed = true;
  }
  /** @internal A2.3: the backend reports a bus's peak. */
  _setPeak(name, peak) {
    const s = this.buses.get(name);
    if (s) s.peak = peak;
  }
  /**
   * @internal ADR 0158: bus automation computed on main, used only where the backend can't run it itself (the
   * TypeScript evaluator on the Babylon fallback). The core applies BUS_AUTOMATE in the audio thread and never calls this.
   */
  _setAutomation(name, gain, lowpass) {
    const s = this.buses.get(name);
    if (!s || s.autoGain === gain && s.autoLp === lowpass) return;
    s.autoGain = gain;
    s.autoLp = lowpass;
    this._dirty();
  }
  /**
   * @internal ADR 0158 §3 (M2 F2): bus automation the core applies in the audio thread, as main estimates it. It only
   * shows in `Bus.effectiveGain` (multiplied with snapshots, ducking and parents); `resolve` leaves it out, since the
   * core applies it itself and a backend must not apply it twice. No change notification: nothing is re-applied.
   */
  _setAutomationView(name, gain) {
    const s = this.buses.get(name);
    if (s) s.viewGain = gain;
  }
  /** @internal The view gains of `name` and its ancestors, multiplied. */
  _viewChain(name) {
    let g = 1;
    for (const n of this.chain(name)) g *= this.buses.get(n)?.viewGain ?? 1;
    return g;
  }
  /** @internal A2.3: the core backend resets a bus's live-voice count to the core mirror's (after a bus remap, which reconfigures the mixer and zeroes counts). */
  _setVoiceCount(name, n) {
    const s = this.buses.get(name);
    if (s) s.voices = Math.max(0, n | 0);
  }
  bus(name = MASTER) {
    if (!this.buses.has(name) && !this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[myco] unknown audio bus "${name}". Buses: ${this.order.join(", ")}.`);
    }
    return new Bus(this, name);
  }
  has(name) {
    return this.buses.has(name);
  }
  /** The bus a sound with this output plays on: itself, else the root (with a warning). */
  resolveOutput(name) {
    if (!name) return this.order[0] ?? MASTER;
    if (this.buses.has(name)) return name;
    this.bus(name);
    return this.order[0] ?? MASTER;
  }
  /** @internal Backends call these as sounds start and end, which is what ducking listens to. */
  voiceStarted(name) {
    const s = this.buses.get(name);
    if (s) s.voices++;
  }
  voiceEnded(name) {
    this.voicesEnded++;
    const s = this.buses.get(name);
    if (s && s.voices > 0) s.voices--;
  }
  /** @internal Voices that have ended (or left a bus) since the page began, whichever backend counted them: the event runtime retires instances when this moves, instead of scanning every frame (ADR 0158 §6). */
  voicesEnded = 0;
  /** Fade to a named snapshot (`seconds` 0 = at once). */
  snapshot(name, seconds = 0.5) {
    const snap = this.settings.snapshots.find((s) => s.name === name);
    if (!snap) {
      console.warn(`[myco] unknown audio snapshot "${name}". Snapshots: ${this.snapshotNames.join(", ") || "none"}.`);
      return;
    }
    this.snapshotName = name;
    this.snapFade = seconds;
    for (const [bus, s] of this.buses) this.retarget(s, snap.volumes[bus] ?? 1, snap.lowpass[bus] ?? OFF_HZ, seconds);
  }
  /** Fade back to the plain mix. */
  clearSnapshot(seconds = 0.5) {
    this.snapshotName = null;
    this.snapFade = seconds;
    for (const s of this.buses.values()) this.retarget(s, 1, OFF_HZ, seconds);
  }
  retarget(s, gain, lp, seconds) {
    s.snapFrom = s.snap;
    s.snapTo = gain;
    s.lpFrom = s.lp;
    s.lpTo = lp;
    if (seconds <= 0) {
      s.snap = gain;
      s.lp = lp;
    }
    this._dirty();
  }
  /** @internal */
  _fade(name, to, dur) {
    const s = this.buses.get(name);
    if (!s) return;
    if (dur <= 0) {
      s.volume = to;
      this.fades.delete(name);
      this._dirty();
      return;
    }
    this.fades.set(name, { from: s.volume, to: Math.min(2, Math.max(0, to)), t: 0, dur });
  }
  /** Advance fades, snapshot transitions and ducking by `dt` seconds; tells listeners if anything moved. */
  update(dt) {
    if (dt > 0) {
      for (const [name, f] of this.fades) {
        f.t = Math.min(f.dur, f.t + dt);
        this.buses.get(name).volume = f.from + (f.to - f.from) * (f.t / f.dur);
        if (f.t >= f.dur) this.fades.delete(name);
        this._dirty();
      }
      for (const s of this.buses.values()) {
        if (s.snap !== s.snapTo || s.lp !== s.lpTo) {
          const step = this.snapFade > 0 ? Math.min(1, dt / this.snapFade) : 1;
          s.snap = approach(s.snap, s.snapFrom, s.snapTo, step);
          s.lp = approach(s.lp, s.lpFrom, s.lpTo, step);
          this._dirty();
        }
      }
      for (const [name, s] of this.buses) {
        let goal = 1, time = 0.5;
        for (const r of this.settings.ducking) {
          if (r.target !== name || (this.buses.get(r.trigger)?.voices ?? 0) === 0) continue;
          if (r.amount < goal) {
            goal = r.amount;
            time = r.attack;
          }
        }
        if (goal === 1) time = this.settings.ducking.filter((r) => r.target === name).reduce((m, r) => Math.max(m, r.release), 0);
        if (s.duck !== goal) {
          const step = time > 0 ? Math.min(1, dt / time) : 1;
          s.duck = approach(s.duck, s.duck, goal, step, true);
          this._dirty();
        }
      }
    }
    if (this.changed) {
      this.changed = false;
      for (const l of this.listeners) l();
    }
  }
  /** Called after `update` when any bus changed (a backend re-applies the mix). */
  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  anySolo() {
    for (const s of this.buses.values()) if (s.solo) return true;
    return false;
  }
  chain(name) {
    const out = [];
    for (let n = name; n !== void 0 && out.length < 64; n = this.buses.get(n)?.settings.parent) out.push(n);
    return out;
  }
  /** Whether solo state lets `name` through (it's soloed, under a soloed bus, or on the way to one). */
  audibleUnderSolo(name) {
    if (this.chain(name).some((n) => this.buses.get(n)?.solo)) return true;
    for (const [other, s] of this.buses) if (s.solo && this.chain(other).includes(name)) return true;
    return false;
  }
  resolve(name) {
    const s = this.buses.get(name);
    if (!s) return null;
    const solo = this.anySolo();
    const gainOf = (n, st) => st.mute || solo && !this.audibleUnderSolo(n) ? 0 : st.volume * st.snap * st.duck * st.autoGain;
    let effective = 1;
    for (const n of this.chain(name)) effective *= gainOf(n, this.buses.get(n));
    return {
      name,
      parent: s.settings.parent ?? null,
      gain: gainOf(name, s),
      effectiveGain: effective,
      effects: s.settings.effects,
      snapshotLowpass: Math.min(s.lp, s.autoLp) < OFF_HZ ? Math.min(s.lp, s.autoLp) : null
    };
  }
  resolveAll() {
    return this.order.map((n) => this.resolve(n));
  }
};
var mixer = new Mixer();
function approach(cur, from, to, step, useCur = false) {
  if (step >= 1) return to;
  const start = useCur ? cur : from;
  if (useCur) return cur + (to - cur) * step;
  const span = to - start;
  if (span === 0) return to;
  const progress = Math.min(1, (cur - start) / span + step);
  return progress >= 1 ? to : start + span * progress;
}

// ../../../../src/plugins/audio/runtime/core/context.ts
init_wire_generated();
init_coreDriver();
init_bufferPool();
var ARENA_INITIAL_BYTES = 16 << 20;
var MB = 1 << 20;
var isShellEvent = (data) => typeof data === "object" && data !== null && (data.type === "error" || data.type === "trap");
var CoreLink = class {
  constructor(port) {
    this.port = port;
    this.ready = this.newReady();
    port.onmessage = (event) => this.handleMessage(event.data);
  }
  port;
  /** The host's BATCH pool (§4.7: 4 × 64 KB); returned BATCH buffers come back here. */
  batchPool = createBatchPool();
  /** STATUS blocks received. */
  statusCount = 0;
  /** The newest STATUS block, or null before the first. */
  lastStatus = null;
  /**
   * Resolves on the first STATUS with the ready flag and this ABI's major; rejects on a shell error or a mismatch.
   * A hard rebuild (`_rebind`, A3.4a) replaces it with the new core's.
   */
  ready;
  /** Whether `ready` settled, and how. */
  readyState = "pending";
  /**
   * How STATUS buffers are decoded. `readStatus` builds a new block per message; A1.4's `coreBackend` swaps in a
   * `StatusReader` that fills one preallocated block (the block is then reused: listeners must not keep it).
   */
  statusDecoder = readStatus;
  seq = 0;
  pingSeq = 0;
  settle;
  statusListeners = /* @__PURE__ */ new Set();
  shellListeners = /* @__PURE__ */ new Set();
  /** A pending `ready` and the `settle` that ends it. */
  newReady() {
    const ready = new Promise((resolve, reject) => {
      this.settle = (error) => {
        if (this.readyState !== "pending") return;
        this.readyState = error ? "failed" : "ready";
        if (error) reject(error);
        else resolve();
      };
    });
    ready.catch(() => {
    });
    return ready;
  }
  /**
   * A3.4a, the hard rebuild: tells the old node's processor to stop (`retire`), stops listening to its port and
   * listens to `port` (the new node's) instead. `ready` and `readyState` start again for the new core's first STATUS;
   * listeners, the decoder, `seq` and the counts stay, so everything holding this link carries over. BATCH buffers
   * still out with the old node never come back, so the pool is topped up with new ones.
   */
  _rebind(port) {
    this.retire();
    this.port = port;
    this.readyState = "pending";
    this.ready = this.newReady();
    port.onmessage = (event) => this.handleMessage(event.data);
    const pool = this.batchPool;
    while (pool.available < pool.count) if (!pool.release(new ArrayBuffer(pool.bytes))) break;
  }
  /** A3.4a: asks the current node's processor to stop rendering (`retire`) and stops listening to its port. */
  retire() {
    const message = { type: "retire" };
    try {
      this.port.postMessage(message);
    } catch {
    }
    this.port.onmessage = null;
  }
  /** Fails `ready` (no first STATUS in time, §4.7). No effect once it settled. */
  fail(error) {
    this.settle(error);
  }
  /** Calls `listener` with every STATUS block, in `onmessage`; returns the unsubscribe. */
  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  /** Calls `listener` with every shell event (`error`, `trap`); returns the unsubscribe. */
  onShellEvent(listener) {
    this.shellListeners.add(listener);
    return () => this.shellListeners.delete(listener);
  }
  /** Sends a TIME_PING and returns its `pingSeq`; a later STATUS echoes it. */
  ping() {
    this.pingSeq = this.pingSeq + 1 >>> 0 || 1;
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.TIME_PING, seq: this.nextSeq(), bodyBytes: 4 });
    writeTimePing(view, 0, { pingSeq: this.pingSeq });
    this.port.postMessage(buffer, [buffer]);
    return this.pingSeq;
  }
  /**
   * B3: hands the worklet its end of the channel to the decoder worker (`port` transferred), over which streams flow
   * without main. Goes to the current node; after a hard rebuild the stream manager connects the new one.
   */
  connectStreamPort(port) {
    const message = { type: "streamPort", port };
    this.port.postMessage(message, [port]);
  }
  /** Dev only: a sine of `hz` at `gain` mixed onto the core's output in the shell; `hz <= 0` stops it. */
  debugTone(hz, gain = 0.1) {
    const message = { type: "debugTone", hz, gain };
    this.port.postMessage(message);
  }
  /** The port's `onmessage`: STATUS (copy, then RECYCLE at once), returned buffers, shell events. */
  handleMessage(data) {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 16) return;
      const view = new DataView(data);
      if (view.getUint32(0, true) !== MAGIC) return;
      if (view.getUint16(6, true) !== Kind.STATUS) {
        this.batchPool.release(data);
        return;
      }
      let status = null;
      try {
        status = this.statusDecoder(data);
      } catch {
      }
      writeEnvelope(view, 0, { kind: Kind.RECYCLE, seq: this.nextSeq(), bodyBytes: 0 });
      this.port.postMessage(data, [data]);
      if (status) this.receive(status);
      return;
    }
    if (isShellEvent(data)) {
      if (data.type === "error") this.settle(new Error(data.message));
      for (const listener of this.shellListeners) listener(data);
    }
  }
  receive(status) {
    this.statusCount++;
    this.lastStatus = status;
    if (this.readyState === "pending" && status.flags & STATUS_FLAGS_READY) {
      const major = status.abiVersion >> 8;
      this.settle(major === CORE_ABI_MAJOR ? void 0 : new Error(`audio core: ABI ${major} where ${CORE_ABI_MAJOR} was expected`));
    }
    for (const listener of this.statusListeners) listener(status);
  }
  /** The envelope `seq` for the next message (per sender, on this one port, wraps). BATCHes and clip messages share it. */
  nextSeq() {
    const seq = this.seq;
    this.seq = this.seq + 1 >>> 0;
    return seq;
  }
  /** Posts a finished message (BATCH, CLIP_BEGIN, CLIP_CHUNK, CLIP_UNLOAD, ...), transferring the buffer. */
  post(buffer) {
    this.port.postMessage(buffer, [buffer]);
  }
  /** Stops listening to the port. */
  dispose() {
    this.port.onmessage = null;
    this.statusListeners.clear();
    this.shellListeners.clear();
  }
};

// ../../../../src/plugins/audio/runtime/core/hostClock.ts
function fakeHostClock(start = {}) {
  let raf = start.rafTime ?? 1e3;
  let current = start.currentTime ?? 0;
  let date = start.dateNow ?? 1e6;
  let running = true;
  return {
    rafTime: () => raf,
    outputTimestamp: () => running ? { contextTime: current, performanceTime: raf } : null,
    currentTime: () => current,
    dateNow: () => date,
    fake: true,
    advance(ms) {
      raf += ms;
      date += ms;
      if (running) current += ms / 1e3;
    },
    setRunning(value) {
      running = value;
    },
    restartContext() {
      current = 0;
    }
  };
}

// ../../../../src/plugins/audio/runtime/testing.ts
init_wire_generated();
init_coreDriver();
var LOOPBACK_PRESET = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: DEFAULT_LIMITER_LOOKAHEAD_MS, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 };
var LOOPBACK_RATE = 48e3;
async function createLoopbackHost(options = {}) {
  const nodeFs = "node:fs/promises";
  const { readFile } = await import(
    /* @vite-ignore */
    nodeFs
  );
  const wasm = await readFile(new URL(options.testHooks ? "./wasm/testing/myco_audio_test_hooks.wasm" : "./wasm/myco_audio.wasm", import.meta.url));
  const clock = options.clock ?? fakeHostClock();
  const preset = options.preset ?? LOOPBACK_PRESET;
  const module = new WebAssembly.Module(wasm);
  let rate = LOOPBACK_RATE;
  const spawn = () => {
    const core = instantiateCore(module, preset, rate);
    const toMain = [];
    const toWorklet = [];
    const driver = new CoreDriver(core, (message) => toMain.push(message), clock.dateNow());
    const port = { onmessage: null, postMessage: (message) => toWorklet.push(message) };
    return { core, driver, toMain, toWorklet, port };
  };
  let current = spawn();
  let cores = 1;
  const link = new CoreLink(current.port);
  const statuses = [];
  link.onStatus((s) => statuses.push(s));
  let frame = 0;
  const flush = () => {
    const { toMain, toWorklet, port, driver } = current;
    while (toMain.length || toWorklet.length) {
      for (const message of toMain.splice(0)) port.onmessage?.({ data: message });
      for (const message of toWorklet.splice(0)) {
        if (message instanceof ArrayBuffer) driver.onMessage(message, frame, clock.dateNow());
        else if (message.type === "debugTone") driver.onControl(message);
      }
    }
  };
  return {
    clock,
    link,
    get driver() {
      return current.driver;
    },
    get core() {
      return current.core;
    },
    statuses,
    get frame() {
      return frame;
    },
    get cores() {
      return cores;
    },
    get sampleRate() {
      return rate;
    },
    respawn() {
      current = spawn();
      cores++;
      const node = { connect() {
      }, disconnect() {
      } };
      return { node, port: current.port };
    },
    recreate(sampleRate) {
      rate = sampleRate;
      frame = 0;
      clock.restartContext();
      current = spawn();
      cores++;
      const node = { connect() {
      }, disconnect() {
      } };
      return { node, port: current.port };
    },
    trapNext() {
      const hook = current.core.exports.myco_audio_debug_trap_next;
      if (typeof hook !== "function") throw new Error("trapNext needs createLoopbackHost({ testHooks: true })");
      hook();
    },
    send(buffer) {
      current.port.postMessage(buffer, [buffer]);
      flush();
    },
    renderQuanta(n) {
      const left = new Float32Array(n * QUANTUM_FRAMES);
      const right = new Float32Array(n * QUANTUM_FRAMES);
      for (let i = 0; i < n; i++) {
        const { driver } = current;
        driver.process(frame, clock.dateNow());
        left.set(driver.left, i * QUANTUM_FRAMES);
        right.set(driver.right, i * QUANTUM_FRAMES);
        frame += QUANTUM_FRAMES;
        clock.advance(QUANTUM_FRAMES / rate * 1e3);
        flush();
      }
      return { left, right };
    }
  };
}

// live.ts
init_wire_generated();
var Q = 128;
var FRAMES = 48e3;
var LP = (hz, q = 1) => ({ type: 0, p: [hz, q, 0, 0, 0, 0, 0] });
var HP = (hz, q = 1) => ({ type: 1, p: [hz, q, 0, 0, 0, 0, 0] });
var COMP = (thr) => ({ type: 2, p: [thr, 6, 4, 3e-3, 0.25, 0, 0] });
var REV = (send) => ({ type: 3, p: [send, 0, 0, 0, 0, 0, 0] });
var ROOT = 65535;
var clipData = (tones) => {
  const out = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    let v = 0;
    for (const [hz, a] of tones) v += a * Math.sin(2 * Math.PI * hz * i / LOOPBACK_RATE);
    out[i] = v;
  }
  return out;
};
var Rig = class _Rig {
  seq = 1;
  host;
  left = [];
  static async create() {
    const r = new _Rig();
    r.host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, limiterLookaheadMs: 0, maxBuses: 8 } });
    r.clip(1, clipData([[220, 0.15], [880, 0.1], [1760, 0.05]]));
    r.clip(2, clipData([[330, 0.15], [990, 0.1], [1650, 0.05]]));
    return r;
  }
  clip(id, data) {
    const begin = new ArrayBuffer(16 + 20);
    const bv = new DataView(begin);
    writeEnvelope(bv, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(bv, 0, { clipId: id, frames: FRAMES, channels: 1, sampleRate: LOOPBACK_RATE, format: 0 });
    this.host.send(begin);
    for (let f = 0; f < FRAMES; f += 2048) {
      const n = Math.min(2048, FRAMES - f);
      const chunk = new ArrayBuffer(16 + 16 + n * 4);
      const cv = new DataView(chunk);
      writeEnvelope(cv, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + n * 4 });
      writeClipChunk(cv, 0, { clipId: id, frameOffset: f, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(data.buffer, f * 4, n * 4));
      this.host.send(chunk);
    }
    this.host.renderQuanta(1 + Math.ceil(FRAMES * 4 / (256 * 1024)));
  }
  send(...records) {
    const scratch = new ArrayBuffer(32 + 8192);
    const view = new DataView(scratch);
    let at = 32;
    for (const w of records) at += w(view, at);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.seq++, bodyBytes: at - 16 });
    writeBatchHeader(view, 0, { firstFrame: this.host.frame, count: records.length, flags: 0 });
    this.host.send(scratch.slice(0, at));
  }
  run(q) {
    this.left.push(this.host.renderQuanta(q).left);
  }
  output() {
    const out = new Float32Array(this.left.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.left) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
};
var busConfig = (tree) => (v, o) => writeBusConfig(v, o, { voiceId: 0, frameOffset: ASAP, buses: tree.map((b) => ({ parent: b.parent, effects: b.fx })) });
var busMix = (gains, ramp, lp = []) => (v, o) => writeBusMix(v, o, { voiceId: 0, frameOffset: ASAP, rampFrames: ramp, buses: gains.map((g, i) => ({ gain: g, lpHz: lp[i] ?? 24e3 })) });
var voiceId = (n) => 65536 | n;
var play = (n, clip, bus) => (v, o) => writePlay(v, o, { voiceId: voiceId(n), frameOffset: ASAP, clip, bus, flags: PLAY_FLAGS_MIXED | PLAY_FLAGS_LOOP, group: 0, gate: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 2e4, score: 0, startOffsetFrames: 0 });
var stop = (n) => (v, o) => writeStop(v, o, { voiceId: voiceId(n), frameOffset: ASAP, fadeFrames: 0, reason: 0 });
var setBus = (n, bus) => (v, o) => writeSetParams(v, o, { voiceId: voiceId(n), frameOffset: ASAP, mask: SET_PARAMS_MASK_BUS, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, bus, rampFrames: 0, flags: 0 });
var RAMP = 800;
var base = () => [{ parent: ROOT, fx: [] }, { parent: 0, fx: [LP(8e3)] }, { parent: 0, fx: [COMP(-24)] }];
var GAINS = [1, 0.8, 1];
var sc = [
  { name: "control: no-op (BUS_CONFIG + BUS_MIX resent unchanged)", note: "main resends the whole tree on any edit", edit: (r) => r.send(busConfig(base()), busMix(GAINS, RAMP)) },
  { name: "control: bus gain jump, rampFrames 0", note: "positive control for the click metric", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], 0)) },
  { name: "bus volume 0.8->0.4, rampFrames 800 (60 fps)", note: "BUS_MIX", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], RAMP)) },
  { name: "bus volume 0.8->0.4, rampFrames 128", note: "BUS_MIX", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], Q)) },
  { name: "lowpass cutoff 8000->1200 Hz", note: "BUS_CONFIG, same slot kind", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [LP(1200)] }, base()[2]]), busMix(GAINS, RAMP)) },
  { name: "lowpass cutoff 8000->300 Hz, Q 12 dB", note: "BUS_CONFIG, resonant", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [LP(300, 12)] }, base()[2]]), busMix(GAINS, RAMP)) },
  { name: "compressor threshold -24->-30 dB", note: "BUS_CONFIG, same slot", level: true, edit: (r) => r.send(busConfig([base()[0], base()[1], { parent: 0, fx: [COMP(-30)] }]), busMix(GAINS, RAMP)) },
  { name: "compressor threshold -24->-50 dB", note: "BUS_CONFIG, same slot", level: true, edit: (r) => r.send(busConfig([base()[0], base()[1], { parent: 0, fx: [COMP(-50)] }]), busMix(GAINS, RAMP)) },
  { name: "add effect: highpass 400 Hz after the lowpass", note: "BUS_CONFIG, new slot", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [LP(8e3), HP(400)] }, base()[2]]), busMix(GAINS, RAMP)) },
  { name: "remove effect: lowpass 8000 off the bus", note: "BUS_CONFIG, slot dropped", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [] }, base()[2]]), busMix(GAINS, RAMP)) },
  { name: "remove the first of two effects (LP+HP -> HP)", note: "BUS_CONFIG, slots shift", tree: [{ parent: ROOT, fx: [] }, { parent: 0, fx: [LP(3e3), HP(150)] }, { parent: 0, fx: [COMP(-24)] }], edit: (r) => r.send(busConfig([{ parent: ROOT, fx: [] }, { parent: 0, fx: [HP(150)] }, { parent: 0, fx: [COMP(-24)] }]), busMix(GAINS, RAMP)) },
  { name: "insert an effect before the lowpass (HP 150, LP 8000)", note: "BUS_CONFIG, slots shift", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [HP(150), LP(8e3)] }, base()[2]]), busMix(GAINS, RAMP)) },
  { name: "add a bus at the end (empty, unity)", note: "BUS_CONFIG, count 3->4", edit: (r) => r.send(busConfig([...base(), { parent: 0, fx: [] }]), busMix([...GAINS, 1], RAMP)) },
  { name: "add a bus at the end and move the SFX voice to it", note: "BUS_CONFIG + SET_PARAMS bus", edit: (r) => r.send(busConfig([...base(), { parent: 0, fx: [] }]), busMix([...GAINS, 1], RAMP), setBus(2, 3)) },
  { name: "change parent: SFX moves under Music (gain 0.8, lowpass 8000)", note: "BUS_CONFIG, new tree order", level: true, edit: (r) => r.send(busConfig([base()[0], base()[1], { parent: 1, fx: [COMP(-24)] }]), busMix(GAINS, RAMP)) },
  { name: "insert a bus in the middle (indices shift, voices re-routed)", note: "BUS_CONFIG + SET_PARAMS bus x2", edit: (r) => r.send(busConfig([base()[0], { parent: 0, fx: [] }, base()[1], base()[2]]), busMix([1, 1, 0.8, 1], RAMP), setBus(1, 2), setBus(2, 3)) },
  { name: "reverb send 0.3->0.8 (reverb already on)", note: "BUS_CONFIG, send level", level: true, tree: [{ parent: ROOT, fx: [] }, base()[1], { parent: 0, fx: [COMP(-24), REV(0.3)] }], edit: (r) => r.send(busConfig([{ parent: ROOT, fx: [] }, base()[1], { parent: 0, fx: [COMP(-24), REV(0.8)] }]), busMix(GAINS, RAMP)) },
  { name: "add the first reverb send (convolver off -> on)", note: "BUS_CONFIG, has_reverb 0->1", level: true, edit: (r) => r.send(busConfig([base()[0], base()[1], { parent: 0, fx: [COMP(-24), REV(0.5)] }]), busMix(GAINS, RAMP)) },
  { name: "remove the last reverb send (convolver on -> off, tail mid-flight)", note: "BUS_CONFIG, has_reverb 1->0", level: true, tree: [{ parent: ROOT, fx: [] }, base()[1], { parent: 0, fx: [COMP(-24), REV(0.5)] }], edit: (r) => r.send(busConfig(base()), busMix(GAINS, RAMP)) }
];
function analyse(ref, got, from, level) {
  const n = ref.length;
  let refStep = 0, gotStep = 0, dStep = 0, onset = -1, dPeak = 0;
  for (let i = from; i < n; i++) {
    refStep = Math.max(refStep, Math.abs(ref[i] - ref[i - 1]));
    gotStep = Math.max(gotStep, Math.abs(got[i] - got[i - 1]));
    const d = got[i] - ref[i], dp = got[i - 1] - ref[i - 1];
    dStep = Math.max(dStep, Math.abs(d - dp));
    dPeak = Math.max(dPeak, Math.abs(d));
    if (onset < 0 && Math.abs(d) > 1e-5) onset = i - from;
  }
  const rms = (a, s, e) => {
    let t = 0;
    for (let i = s; i < e; i++) t += a[i] * a[i];
    return Math.sqrt(t / (e - s));
  };
  const qn = Math.floor((n - from) / Q);
  const fin = rms(got, n - 4 * Q, n);
  let settleQ = 0, maxDev = 0;
  for (let k = 0; k < qn; k++) {
    const dev = Math.abs(20 * Math.log10(rms(got, from + k * Q, from + (k + 1) * Q) / fin));
    maxDev = Math.max(maxDev, dev);
    if (dev >= 1) settleQ = k + 1;
  }
  const prePeak = (() => {
    let m = 0;
    for (let i = 0; i < from; i++) m = Math.max(m, Math.abs(ref[i] - got[i]));
    return m;
  })();
  return {
    preEditIdentical: prePeak === 0,
    refMaxStep: +refStep.toFixed(5),
    jumpRatio: +(gotStep / refStep).toFixed(2),
    abrupt: dPeak > 1e-5 ? +(dStep / dPeak).toFixed(2) : 0,
    stepDbfs: dStep > 0 ? +(20 * Math.log10(dStep)).toFixed(1) : -200,
    onsetFrames: onset,
    diffPeak: +dPeak.toFixed(4),
    settleMs: level && maxDev >= 1 ? +(settleQ * Q / LOOPBACK_RATE * 1e3).toFixed(1) : null
  };
}
async function runOne(s, withEdit, warm) {
  const r = await Rig.create();
  const tree = s.tree ?? base();
  r.send(busConfig(tree), busMix(GAINS, 0), play(1, 1, 1), play(2, 2, 2));
  r.run(warm);
  if (withEdit) s.edit(r);
  else if (s.name.startsWith("control: no-op")) {
  }
  r.run(64 - warm);
  return r.output();
}
var rows = [];
for (const s of sc) {
  const rs = [];
  for (const warm of [12, 13, 14, 15, 16, 17, 18, 19]) {
    const ref = await runOne(s, false, warm);
    const got = await runOne(s, true, warm);
    rs.push(analyse(ref, got, warm * Q, !!s.level));
  }
  const worst = (k) => Math.max(...rs.map((r) => Number(r[k] ?? -1)));
  rows.push({
    edit: s.name,
    via: s.note,
    preEditIdentical: rs.every((r) => r.preEditIdentical),
    abrupt: worst("abrupt"),
    stepDbfs: worst("stepDbfs"),
    verdict: worst("abrupt") > 0.3 ? "CLICK" : worst("abrupt") === 0 ? "identical" : "smooth",
    jumpRatio: worst("jumpRatio"),
    diffPeak: worst("diffPeak"),
    onsetFramesMin: Math.min(...rs.map((r) => r.onsetFrames)),
    settleMs: rs.some((r) => r.settleMs !== null) ? worst("settleMs") : null
  });
}
{
  const withRev = [{ parent: ROOT, fx: [] }, base()[1], { parent: 0, fx: [COMP(-24), REV(0.5)] }];
  const go = async (remove) => {
    const r = await Rig.create();
    r.send(busConfig(withRev), busMix(GAINS, 0), play(1, 1, 1), play(2, 2, 2));
    r.run(60);
    r.send(remove ? busConfig(base()) : busConfig(withRev), busMix(GAINS, RAMP), stop(1), stop(2));
    r.run(20);
    r.send(busConfig(withRev), busMix(GAINS, RAMP));
    r.run(8);
    return r.output();
  };
  const ref = await go(false), got = await go(true);
  const peak = (a, q0, q1) => {
    let m = 0;
    for (let i = q0 * Q; i < q1 * Q; i++) m = Math.max(m, Math.abs(a[i]));
    return +m.toExponential(2);
  };
  rows.push({
    edit: "reverb tail when the last send is removed (dry stopped), then the send returns 20 quanta later",
    tailRingingInReference_q64to70: peak(ref, 64, 70),
    tailAfterRemoval_q64to70: peak(got, 64, 70),
    outputWhileSendIsBack_afterReAdd_q80to88: peak(got, 80, 88),
    referenceSameWindow: peak(ref, 80, 88),
    verdict: peak(got, 64, 70) === 0 && peak(ref, 64, 70) > 1e-3 ? "tail cut to silence in one quantum" : "tail rings out",
    staleTailReplaysOnReAdd: peak(got, 80, 88) > 1e-3
  });
}
console.log(JSON.stringify(rows));
