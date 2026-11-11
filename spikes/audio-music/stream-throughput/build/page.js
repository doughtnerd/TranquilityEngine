// ../../../src/plugins/audio/runtime/wire.generated.ts
var MAGIC = 1297695025;
var VERSION_MAJOR = 1;
var VERSION_MINOR = 1;
var ASAP = 4294967295;
var ErrorCode = {
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
var WireError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
};
var Kind = {
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
var BATCH_HEADER_FIXED_END = 32;
function writeBatchHeader(view, off, rec) {
  view.setFloat64(off + 16, rec.firstFrame, true);
  view.setUint32(off + 24, rec.count, true);
  view.setUint32(off + 28, rec.flags, true);
  let cur = off + 32;
  return cur - off;
}
var PLAY_FLAGS_LOOP = 1;
var PLAY_FLAGS_STREAM = 2;
var PLAY_FLAGS_WANTS_PLAYHEAD = 4;
var PLAY_FLAGS_MIXED = 8;
var PLAY_FIXED_END = 56;
function writePlay(view, off, rec) {
  view.setUint32(off + 12, rec.clip, true);
  view.setUint16(off + 16, rec.bus, true);
  view.setUint16(off + 18, rec.flags, true);
  view.setUint16(off + 20, rec.group, true);
  view.setUint16(off + 22, rec.reserved, true);
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
function readStatus(buf) {
  const view = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const off = 0;
  if (144 > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");
  const env = readEnvelope(view, 0);
  if (env.magic !== MAGIC) throw new WireError(ErrorCode.BAD_MAGIC, "STATUS: bad magic");
  if ((env.version ?? 0) >> 8 !== VERSION_MAJOR) throw new WireError(ErrorCode.VERSION_MISMATCH, "STATUS: version mismatch");
  if (env.kind !== Kind.STATUS) throw new WireError(ErrorCode.MALFORMED, "STATUS: wrong kind");
  const limit = 16 + env.bodyBytes;
  if (limit > view.byteLength || limit < 144) throw new WireError(ErrorCode.TRUNCATED, "STATUS: truncated");
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
  let cur = 144;
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
  return { currentFrame, dateMs, pingSeq, pingFrameLo, underruns, lateCommands, workUnits, workUnitsMax, mixedVoices, liveVoices, flags, mixedCap, loadPermille, traps, minSlackFrames, underrunFrames, arenaUsedKB, arenaLargestFreeKB, abiVersion, maxLatenessFrames, hrtfVoices, hrtfLoadFailure, bedVoices, fxVoices, ambisonicVoices, zonesActive, zonesRinging, bedsRefused, m3Shed, zoneUsedKB, workBed, workZones, ended, demoted, starved, playheads, clipEvents, streamEvents, peaks, beds, zones, zoneEvents };
}

// src/page.ts
var RATE = 48e3;
async function runCase(o) {
  const [coreWasm, decWasm, fileBytes] = await Promise.all([
    fetch("/myco_audio.wasm").then((r) => r.arrayBuffer()),
    fetch("/myco_audio_decode.wasm").then((r) => r.arrayBuffer()),
    fetch("/" + o.file).then((r) => r.arrayBuffer())
  ]);
  const frames = Math.round(o.seconds * RATE);
  const ctx = o.realtime ? new AudioContext({ sampleRate: RATE, latencyHint: "interactive" }) : new OfflineAudioContext(2, frames + 4 * RATE, RATE);
  await ctx.audioWorklet.addModule("/processor.js");
  const preset = { maxLogical: 1024, maxMixed: o.mixed, maxBuses: 32, arenaInitialBytes: 16 << 20, clipCeilingBytes: 64 << 20, limiterLookaheadMs: 1.5, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0 };
  const node = new AudioWorkletNode(ctx, "myco-audio-core", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { wasm: coreWasm, preset } });
  node.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  const tbuf = new Float32Array(2048);
  const out = {
    N: o.N,
    mixed: o.mixed,
    ringsExpected: Math.min(16, Math.max(4, Math.floor(o.mixed / 16))),
    statusBlocks: 0,
    starvedVoiceReports: 0,
    streamEventStarved: 0,
    streamEventEos: 0,
    streamEventError: 0,
    starveTimes: [],
    underruns: 0,
    underrunFrames: 0,
    lateCommands: 0,
    liveVoicesMax: 0,
    mixedVoicesMax: 0,
    minSlackFramesMin: 1e9,
    loadPermillePeak: 0,
    peakMax: 0,
    errors: [],
    startMs: [],
    opened: 0,
    workerErrors: [],
    ctxTimeAtPlay: 0,
    ctxTimeAtEnd: 0,
    wallMsRun: 0,
    outPeak: 0,
    killed: false
  };
  let seq = 1;
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d instanceof ArrayBuffer) {
      const v = new DataView(d);
      if (v.getUint16(6, true) === Kind.STATUS) {
        const s = readStatus(d);
        out.statusBlocks++;
        out.starvedVoiceReports += s.starved.length;
        for (const ev of s.streamEvents) {
          if (ev.code === 1) {
            out.streamEventStarved++;
            out.starveTimes.push(+(ctx.currentTime ?? 0).toFixed(3));
          } else if (ev.code === 2) out.streamEventEos++;
          else if (ev.code === 3) out.streamEventError++;
        }
        out.underruns = s.underruns;
        out.underrunFrames = s.underrunFrames;
        out.lateCommands = s.lateCommands;
        out.liveVoicesMax = Math.max(out.liveVoicesMax, s.liveVoices);
        out.mixedVoicesMax = Math.max(out.mixedVoicesMax, s.mixedVoices);
        out.minSlackFramesMin = Math.min(out.minSlackFramesMin, s.minSlackFrames);
        out.loadPermillePeak = Math.max(out.loadPermillePeak, s.loadPermille);
        for (const p of s.peaks) out.peakMax = Math.max(out.peakMax, p.l, p.r);
        const rec = new ArrayBuffer(16);
        writeEnvelope(new DataView(rec), 0, { kind: Kind.RECYCLE, seq: seq++, bodyBytes: 0 });
        const back = d;
        writeEnvelope(new DataView(back), 0, { kind: Kind.RECYCLE, seq: seq++, bodyBytes: 0 });
        node.port.postMessage(back, [back]);
      }
    } else if (d && (d.type === "error" || d.type === "trap")) out.errors.push(d.type + ": " + d.message);
  };
  const worker = new Worker("/decoder.worker.js", { type: "module" });
  const ready = new Promise((res, rej) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") res();
      else if (m.type === "streamOpened") out.opened++;
      else if (m.type === "error") {
        out.workerErrors.push(m.message);
        if (m.fatal) rej(new Error(m.message));
      }
    };
  });
  worker.postMessage({ type: "init", wasmBytes: decWasm.slice(0) });
  await ready;
  const ch = new MessageChannel();
  node.port.postMessage({ type: "streamPort", port: ch.port2 }, [ch.port2]);
  worker.postMessage({ type: "connectWorklet", port: ch.port1 }, [ch.port1]);
  const play = async () => {
    const t0 = performance.now();
    for (let i = 0; i < o.N; i++) {
      worker.postMessage({ type: "streamOpen", streamId: i + 1, asset: o.file, bytes: fileBytes.slice(0), hint: o.hint, startFrame: 0, epoch: 1, loop: o.loop }, []);
    }
    const bytes = 16 + BATCH_HEADER_FIXED_END - 16 + o.N * PLAY_FIXED_END;
    const buf = new ArrayBuffer(Math.max(bytes, 64));
    const v = new DataView(buf);
    let pos = BATCH_HEADER_FIXED_END;
    for (let i = 0; i < o.N; i++) {
      pos += writePlay(v, pos, { voiceId: 1 << 16 | i, frameOffset: ASAP, clip: i + 1, bus: 0, flags: PLAY_FLAGS_STREAM | PLAY_FLAGS_WANTS_PLAYHEAD | PLAY_FLAGS_MIXED | (o.loop ? PLAY_FLAGS_LOOP : 0), group: 0, reserved: 0, gain: 0.5 / Math.sqrt(Math.max(1, o.N)), pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 0, score: 1, startOffsetFrames: 0 });
    }
    writeEnvelope(v, 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: pos - 16 });
    writeBatchHeader(v, 0, { firstFrame: 0, count: o.N, flags: 0 });
    node.port.postMessage(buf, [buf]);
    return t0;
  };
  let wall0 = 0;
  if (o.realtime) {
    const ac = ctx;
    await ac.resume();
    await new Promise((r) => setTimeout(r, 500));
    out.ctxTimeAtPlay = ac.currentTime;
    wall0 = performance.now();
    await play();
    await new Promise((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(tbuf);
        for (let i = 0; i < tbuf.length; i++) out.outPeak = Math.max(out.outPeak, Math.abs(tbuf[i]));
        const el = ac.currentTime - out.ctxTimeAtPlay;
        if (o.killWorkerAt && !out.killed && el >= o.killWorkerAt) {
          out.killed = true;
          worker.terminate();
        }
        if (el >= o.seconds) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
    out.ctxTimeAtEnd = ac.currentTime;
    out.wallMsRun = performance.now() - wall0;
  } else {
    await play();
    await ctx.startRendering();
  }
  await new Promise((r) => setTimeout(r, 200));
  worker.terminate();
  if (o.realtime) await ctx.close();
  if (out.minSlackFramesMin === 1e9) out.minSlackFramesMin = -1;
  return out;
}
globalThis.runCase = runCase;
export {
  runCase
};
