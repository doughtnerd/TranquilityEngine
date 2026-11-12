// Candidate capture codec (spike S3). Binary record stream + preallocated ring + reader. Not production code.
//
// Stream = sequence of records, times in microseconds since capture start, delta from the previous record (varint):
//   KF     0x01 len3 dt  voiceTable        (keyframe; resets the STATUS delta chain; ring tail always sits on a KF)
//   STATUS 0x02 len3 dt  body              (delta vs previous STATUS in the chain; peaks quantised 0.01 dB)
//   STATUSL 0x03 len3 dt body              (same, peaks lossless f32)
//   STATUSR 0x04 len3 dt rawBytes          (the wire STATUS block as received; the "raw" mode, for size comparison)
//   EVENT  0x10+k  dt  fields              (self-delimiting by type)
import { SCHEMA_HASH } from "../../../src/plugins/audio/runtime/wire.generated.ts";

export const T = { KF: 1, STATUS: 2, STATUSL: 3, STATUSR: 4, EV: 0x10 };
// Event types (main-side): see README "event vocabulary".
export const EV = {
  VOICE_START: 0, // voice, clip, bus, priority
  VOICE_STOP: 1, // voice, reason (0 finished 1 stopped 2 bus-stopped 3 owner-destroyed)
  VOICE_STEAL: 2, // voice, byVoice, reason (0 priority 1 bus-limit 2 global-limit)
  VOICE_VIRT: 3, // voice, reason (0 adaptive cap 1 audibility 2 shed-ladder 3 occlusion)
  EVT_START: 4, // instance, asset
  EVT_STOP: 5, // instance, reason
  PARAM: 6, // target(instance or 0=global), paramId, f32 value
  MUSIC: 7, // instance, fromSegment, toSegment, kind
  BUS_MIX: 8, // bus, f32 gain, lpHz, hpHz
};
const EV_F32 = { 6: true, 8: true }; // events whose last field is an f32 value (BUS_MIX: gain f32 then two varints)

const HDR_KEYS = ["currentFrame", "dateMs", "pingSeq", "pingFrameLo", "underruns", "lateCommands", "workUnits", "workUnitsMax", "mixedVoices", "liveVoices", "flags", "mixedCap", "loadPermille", "traps", "minSlackFrames", "underrunFrames", "arenaUsedKB", "arenaLargestFreeKB", "abiVersion", "maxLatenessFrames", "hrtfVoices", "hrtfLoadFailure", "bedVoices", "fxVoices", "ambisonicVoices", "zonesActive", "zonesRinging", "bedsRefused", "m3Shed", "zoneUsedKB", "workBed", "workZones", "musicRingsOpen", "streamStartsLate", "groupsLate", "groupsHeld", "groupsAbandoned", "curvePoolFull", "maxSlipFrames", "splitQuanta", "voiceSplits", "reserved"];
const NH = HDR_KEYS.length;
const SECTIONS = [
  ["beds", ["bus", "voices", "work"]],
  ["zones", ["kernelId", "state", "pad", "quantaSinceInput", "wetPeak"]],
  ["zoneEvents", ["slot", "code", "reserved"]],
  ["musicRings", ["streamId", "epochFlags"]],
  ["groupStarts", ["groupId", "flags", "slipFrames", "startFrameLo", "startFrameHi"]],
  ["clipEvents", ["clipId", "code"]],
  ["streamEvents", ["id", "code"]],
];
export const HASH_TABLE = 4096;
const EMPTY = new Uint8Array(0);
const F32 = new DataView(new ArrayBuffer(8));

export const peakQ = (v) => (v < 1e-6 ? -12000 : Math.max(-12000, Math.min(1200, Math.round(2000 * Math.log10(v)))));
export const peakDQ = (q) => (q <= -12000 ? 0 : 10 ** (q / 2000));
const zz = (d) => (d >= 0 ? d * 2 : -d * 2 - 1);
const unzz = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Per-chain delta state, shared in shape by encoder and decoder. Everything preallocated. */
class Chain {
  constructor() {
    this.hdr = new Float64Array(NH);
    this.peakQ = new Int32Array(64);
    this.peakN = 0;
    this.phId = new Int32Array(HASH_TABLE);
    this.phClip = new Float64Array(HASH_TABLE);
    this.phFrame = new Float64Array(HASH_TABLE);
    this.sec = SECTIONS.map(() => EMPTY);
  }
  reset() {
    this.hdr.fill(0);
    this.peakQ.fill(0);
    this.peakN = 0;
    this.phId.fill(0);
    this.phClip.fill(0);
    this.phFrame.fill(0);
    for (let i = 0; i < this.sec.length; i++) this.sec[i] = EMPTY;
  }
}

/** Preallocated power-of-two ring. Positions are absolute; the byte at p lives at p & mask. */
export class Recorder {
  constructor(capBytes, { quantPeaks = true } = {}) {
    if (capBytes & (capBytes - 1)) throw new Error("capBytes must be a power of two");
    this.buf = new Uint8Array(capBytes);
    this.mask = capBytes - 1;
    this.cap = capBytes;
    this.head = 0;
    this.tail = 0;
    this.kfOff = new Float64Array(8192); // absolute offsets of keyframes still in the ring (ring of 8192)
    this.kfT = new Float64Array(8192);
    this.kfHead = 0;
    this.kfTail = 0;
    this.lastUs = 0;
    this.quant = quantPeaks;
    this.chain = new Chain();
    this.scratch = new Uint8Array(4096);
    this.maxRec = 96 * 1024; // slack kept free ahead of the head
    this.stats = { status: 0, kf: 0, ev: 0, raw: 0 }; // bytes written per class, for the size tables
  }
  // --- primitives (no allocation) ---
  u8(b) { this.buf[this.head++ & this.mask] = b; }
  vu(n) {
    while (n >= 128) { this.buf[this.head++ & this.mask] = (n % 128) | 128; n = Math.floor(n / 128); }
    this.buf[this.head++ & this.mask] = n;
  }
  vs(d) { this.vu(zz(d)); }
  f32(x) {
    F32.setFloat32(0, x, true);
    this.u8(F32.getUint8(0)); this.u8(F32.getUint8(1)); this.u8(F32.getUint8(2)); this.u8(F32.getUint8(3));
  }
  begin(type, tUs) {
    const start = this.head;
    this.u8(type);
    return start;
  }
  dt(tUs) { const d = Math.max(0, Math.round(tUs - this.lastUs)); this.lastUs = tUs; this.vu(d); }
  len3(startOfLen) { this.head += 3; return startOfLen; }
  patchLen(lenPos, bodyStart) {
    const n = this.head - bodyStart;
    this.buf[lenPos & this.mask] = (n & 127) | 128;
    this.buf[(lenPos + 1) & this.mask] = ((n >> 7) & 127) | 128;
    this.buf[(lenPos + 2) & this.mask] = (n >> 14) & 127;
  }
  evict() {
    while (this.head - this.tail > this.cap - this.maxRec && this.kfTail + 1 < this.kfHead) {
      this.kfTail++;
      this.tail = this.kfOff[this.kfTail & 8191];
    }
  }
  // --- records ---
  /** Voice-table keyframe: SoA arrays of the main-side voice table, rows 0..n-1 (live voices only). */
  keyframe(tUs, n, tbl) {
    const s0 = this.head;
    this.kfOff[this.kfHead & 8191] = s0;
    this.kfT[this.kfHead & 8191] = tUs;
    this.kfHead++;
    this.u8(T.KF);
    const lp = this.head; this.head += 3;
    const bs = this.head;
    this.dt(tUs);
    this.vu(n);
    for (let i = 0; i < n; i++) {
      this.vu(tbl.id[i]); this.vu(tbl.clip[i]); this.u8(tbl.bus[i]); this.u8(tbl.state[i]); this.u8(tbl.prio[i]);
      this.f32(tbl.gain[i]);
      this.vu(Math.round(tbl.pitch[i] * 4096)); this.vu(Math.round(Math.min(1, tbl.aud[i]) * 65535)); this.vu(tbl.playhead[i]);
    }
    this.patchLen(lp, bs);
    this.chain.reset();
    this.stats.kf += this.head - s0;
    this.evict();
  }
  /** STATUS block, delta vs the previous one in the chain. `b` is the (reused) decoded block. */
  status(tUs, b) {
    const s0 = this.head;
    const ch = this.chain;
    this.u8(this.quant ? T.STATUS : T.STATUSL);
    const lp = this.head; this.head += 3;
    const bs = this.head;
    this.dt(tUs);
    // header: bitmap of changed fields, then zigzag deltas
    let mapPos = this.head; this.head += Math.ceil(NH / 8);
    const mapBytes = Math.ceil(NH / 8);
    for (let k = 0; k < mapBytes; k++) this.buf[(mapPos + k) & this.mask] = 0;
    for (let i = 0; i < NH; i++) {
      let v = b[HDR_KEYS[i]];
      if (i === 1) v = Math.round(v * 1000); // dateMs -> whole microseconds
      const d = v - ch.hdr[i];
      if (d !== 0) {
        this.buf[(mapPos + (i >> 3)) & this.mask] |= 1 << (i & 7);
        this.vs(d);
        ch.hdr[i] = v;
      }
    }
    // id lists: count, then zigzag delta from the previous id
    this.idList(b.ended); this.idList(b.demoted); this.idList(b.starved);
    // playheads: 1 byte per item when the id gap is small and the prediction (pitch 1) is right
    const ph = b.playheads;
    this.vu(ph.length);
    let prevId = 0;
    for (let i = 0; i < ph.length; i++) {
      const it = ph[i];
      const h = it.id & (HASH_TABLE - 1);
      const pred = ch.phId[h] === it.id ? ch.phClip[h] + (b.currentFrame - ch.phFrame[h]) : 0;
      const res = it.clipFrame - pred;
      const gap = it.id - prevId;
      const small = gap >= 1 && gap <= 14;
      this.u8((small ? gap : 15) | (res !== 0 ? 16 : 0));
      if (!small) this.vs(gap);
      if (res !== 0) this.vs(res);
      ch.phId[h] = it.id; ch.phClip[h] = it.clipFrame; ch.phFrame[h] = b.currentFrame;
      prevId = it.id;
    }
    // peaks
    const pk = b.peaks;
    this.vu(pk.length);
    if (this.quant) {
      for (let i = 0; i < pk.length; i++) {
        const ql = peakQ(pk[i].l), qr = peakQ(pk[i].r);
        this.vs(ql - ch.peakQ[2 * i]); this.vs(qr - ch.peakQ[2 * i + 1]);
        ch.peakQ[2 * i] = ql; ch.peakQ[2 * i + 1] = qr;
      }
    } else {
      for (let i = 0; i < pk.length; i++) { this.f32(pk[i].l); this.f32(pk[i].r); }
    }
    // rare sections: 2-bit tag each (0 empty, 1 same as previous block, 2 new), then new ones
    let tags = 0;
    const sc = this.scratch;
    let pending = 0;
    for (let s = 0; s < SECTIONS.length; s++) {
      const list = b[SECTIONS[s][0]];
      if (list.length === 0) { if (ch.sec[s].length !== 0) ch.sec[s] = EMPTY; continue; }
      const n = this.sectionBytes(s, list, sc);
      const prev = ch.sec[s];
      let same = prev.length === n;
      for (let k = 0; same && k < n; k++) if (prev[k] !== sc[k]) same = false;
      if (same) tags |= 1 << (2 * s);
      else { tags |= 2 << (2 * s); ch.sec[s] = sc.slice(0, n); pending |= 1 << s; }
    }
    this.u8(tags & 255); this.u8(tags >> 8);
    for (let s = 0; s < SECTIONS.length; s++) if (pending & (1 << s)) { const c = ch.sec[s]; for (let k = 0; k < c.length; k++) this.u8(c[k]); }
    this.patchLen(lp, bs);
    this.stats.status += this.head - s0;
    this.evict();
  }
  idList(list) {
    this.vu(list.length);
    let prev = 0;
    for (let i = 0; i < list.length; i++) { this.vs(list[i] - prev); prev = list[i]; }
  }
  sectionBytes(s, list, sc) {
    // varint count then every field as varint (wetPeak as f32 bits)
    let p = 0;
    sc[p++] = list.length;
    for (const it of list) for (const key of SECTIONS[s][1]) {
      let v = it[key];
      if (key === "wetPeak") { F32.setFloat32(0, v, true); v = F32.getUint32(0, true); }
      while (v >= 128) { sc[p++] = (v % 128) | 128; v = Math.floor(v / 128); }
      sc[p++] = v;
    }
    return p;
  }
  /** The raw mode: the wire STATUS bytes as received. */
  statusRaw(tUs, bytes, n) {
    const s0 = this.head;
    this.u8(T.STATUSR);
    const lp = this.head; this.head += 3;
    const bs = this.head;
    this.dt(tUs);
    const buf = this.buf, mask = this.mask;
    let p = this.head;
    for (let i = 0; i < n; i++) buf[p++ & mask] = bytes[i];
    this.head = p;
    this.patchLen(lp, bs);
    this.stats.raw += this.head - s0;
    this.evict();
  }
  /** Event: type, a, b, c, d varints; for PARAM/BUS_MIX the f32 comes first after the ids. */
  event(tUs, type, a, b, c, d, f) {
    const s0 = this.head;
    this.u8(T.EV + type);
    this.dt(tUs);
    this.vu(a); this.vu(b); this.vu(c); this.vu(d);
    if (EV_F32[type]) this.f32(f);
    this.stats.ev += this.head - s0;
    this.evict();
  }
  /** Linearise the live window into one buffer (the one allocation, at save time). */
  linearise() {
    const out = new Uint8Array(this.head - this.tail);
    const start = this.tail & this.mask;
    const n = out.length;
    if (start + n <= this.cap) out.set(this.buf.subarray(start, start + n));
    else { const first = this.cap - start; out.set(this.buf.subarray(start), 0); out.set(this.buf.subarray(0, n - first), first); }
    return out;
  }
}

// ---------------- reader (editor side; allocation is fine here) ----------------
export class Reader {
  get ch() { return (this._ch ??= new Chain()); }
  constructor(buf) { this.b = buf; this.p = 0; this.t = 0; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { return this.b[this.p++]; }
  vu() { let n = 0, m = 1, c; do { c = this.b[this.p++]; n += (c & 127) * m; m *= 128; } while (c & 128); return n; }
  vs() { return unzz(this.vu()); }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  len3() { const n = (this.b[this.p] & 127) | ((this.b[this.p + 1] & 127) << 7) | ((this.b[this.p + 2] & 127) << 14); this.p += 3; return n; }
  /** Scan the record headers only (no body decode): returns {kfOff, kfT} (the index a file without a footer needs). */
  scanIndex() {
    const kfOff = [], kfT = [];
    this.p = 0; this.t = 0;
    const end = this.b.length;
    while (this.p < end) {
      const at = this.p;
      const ty = this.u8();
      if (ty >= T.EV) { this.t += this.vu(); this.p = this.skipEvent(ty - T.EV); continue; }
      const n = this.len3();
      const bodyStart = this.p;
      this.t += this.vu();
      if (ty === T.KF) { kfOff.push(at); kfT.push(this.t); }
      this.p = bodyStart + n;
    }
    return { kfOff, kfT };
  }
  skipEvent(type) { this.vu(); this.vu(); this.vu(); this.vu(); if (EV_F32[type]) this.p += 4; return this.p; }
  /** Decode one record at this.p; returns {type, t, ...}. */
  next() {
    const ty = this.u8();
    if (ty >= T.EV) {
      const type = ty - T.EV;
      this.t += this.vu();
      const a = this.vu(), b = this.vu(), c = this.vu(), d = this.vu();
      const f = EV_F32[type] ? this.f32() : 0;
      return { rec: "event", type, t: this.t, a, b, c, d, f };
    }
    const n = this.len3();
    const end = this.p + n;
    this.t += this.vu();
    if (ty === T.KF) {
      const cnt = this.vu();
      const rows = new Array(cnt);
      for (let i = 0; i < cnt; i++) {
        rows[i] = { id: this.vu(), clip: this.vu(), bus: this.u8(), state: this.u8(), prio: this.u8(), gain: this.f32(), pitch: this.vu() / 4096, aud: this.vu() / 65535, playhead: this.vu() };
      }
      this.ch.reset();
      this.p = end;
      return { rec: "kf", t: this.t, rows };
    }
    if (ty === T.STATUSR) { this.p = end; return { rec: "statusRaw", t: this.t }; }
    const quant = ty === T.STATUS;
    const ch = this.ch;
    const b = {};
    const mapBytes = Math.ceil(NH / 8);
    const mapPos = this.p; this.p += mapBytes;
    for (let i = 0; i < NH; i++) if (this.b[mapPos + (i >> 3)] & (1 << (i & 7))) ch.hdr[i] += this.vs();
    for (let i = 0; i < NH; i++) b[HDR_KEYS[i]] = i === 1 ? ch.hdr[1] / 1000 : ch.hdr[i];
    for (const name of ["ended", "demoted", "starved"]) {
      const cnt = this.vu(); const l = new Array(cnt); let prev = 0;
      for (let i = 0; i < cnt; i++) { prev += this.vs(); l[i] = prev; }
      b[name] = l;
    }
    const cnt = this.vu(); b.playheads = new Array(cnt);
    let prevId = 0;
    for (let i = 0; i < cnt; i++) {
      const code = this.u8();
      let gap = code & 15; if (gap === 15) gap = this.vs();
      const id = prevId + gap;
      const h = id & (HASH_TABLE - 1);
      const pred = ch.phId[h] === id ? ch.phClip[h] + (b.currentFrame - ch.phFrame[h]) : 0;
      const clipFrame = pred + (code & 16 ? this.vs() : 0);
      ch.phId[h] = id; ch.phClip[h] = clipFrame; ch.phFrame[h] = b.currentFrame;
      b.playheads[i] = { id, clipFrame }; prevId = id;
    }
    const pn = this.vu(); b.peaks = new Array(pn);
    for (let i = 0; i < pn; i++) {
      if (quant) {
        ch.peakQ[2 * i] += this.vs(); ch.peakQ[2 * i + 1] += this.vs();
        b.peaks[i] = { l: peakDQ(ch.peakQ[2 * i]), r: peakDQ(ch.peakQ[2 * i + 1]) };
      } else b.peaks[i] = { l: this.f32(), r: this.f32() };
    }
    const tags = this.u8() | (this.u8() << 8);
    for (let s = 0; s < SECTIONS.length; s++) {
      const tag = (tags >> (2 * s)) & 3;
      if (tag === 0) { b[SECTIONS[s][0]] = []; ch.sec[s] = EMPTY; continue; }
      if (tag === 2) { const st = this.p; this.p = this.skipSection(s); ch.sec[s] = this.b.slice(st, this.p); }
      b[SECTIONS[s][0]] = this.parseSection(s, ch.sec[s]);
    }
    this.p = end;
    return { rec: "status", t: this.t, b };
  }
  skipSection(s) { const cnt = this.u8(); for (let i = 0; i < cnt * SECTIONS[s][1].length; i++) this.vu(); return this.p; }
  parseSection(s, bytes) {
    const r = new Reader(bytes);
    const cnt = r.u8(); const out = [];
    for (let i = 0; i < cnt; i++) {
      const it = {};
      for (const key of SECTIONS[s][1]) {
        let v = r.vu();
        if (key === "wetPeak") { F32.setUint32(0, v, true); v = F32.getFloat32(0, true); }
        it[key] = v;
      }
      out.push(it);
    }
    return out;
  }
}

// ---------------- file header (proposal; section 5 of the README) ----------------
export const FILE_MAGIC = "MYCAP\x00\x01\x1a"; // 8 bytes: 'MYCAP', NUL, format byte 1, 0x1a (stops a DOS type)
export const FORMAT_VERSION = 1;
export function writeFileHeader(meta) {
  const json = new TextEncoder().encode(JSON.stringify(meta.tables)); // clip names, bus names: the string table
  const out = new Uint8Array(8 + 2 + 2 + 16 + 2 + 2 + 4 + 2 + 1 + 1 + 8 + 4 + 4 + json.length);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const ch of FILE_MAGIC) out[p++] = ch.charCodeAt(0);
  dv.setUint16(p, FORMAT_VERSION, true); p += 2;
  dv.setUint16(p, meta.flags ?? 0, true); p += 2; // bit0 peaks quantised, bit1 deflate-raw chunks
  for (let i = 0; i < 16; i++) out[p++] = parseInt((meta.schemaHash ?? SCHEMA_HASH).slice(i * 2, i * 2 + 2), 16);
  dv.setUint16(p, meta.wireMajor ?? 1, true); p += 2;
  dv.setUint16(p, meta.wireMinor ?? 2, true); p += 2;
  dv.setUint32(p, meta.sampleRate, true); p += 4;
  dv.setUint16(p, meta.quantumFrames ?? 128, true); p += 2;
  out[p++] = meta.statusEveryQuanta ?? 6;
  out[p++] = meta.preset ?? 1; // 0 low 1 default 2 high 3 custom
  dv.setFloat64(p, meta.startDateMs, true); p += 8;
  dv.setUint32(p, meta.keyframeUs ?? 1_000_000, true); p += 4;
  dv.setUint32(p, json.length, true); p += 4;
  out.set(json, p);
  return out;
}
export function readFileHeader(buf, { schemaHash = SCHEMA_HASH } = {}) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  for (const ch of FILE_MAGIC) if (buf[p++] !== ch.charCodeAt(0)) return { ok: false, refused: "not a Myco capture (bad magic)" };
  const version = dv.getUint16(p, true); p += 2;
  if (version !== FORMAT_VERSION) return { ok: false, refused: `capture format ${version}, this editor reads ${FORMAT_VERSION}` };
  const flags = dv.getUint16(p, true); p += 2;
  let hash = ""; for (let i = 0; i < 16; i++) hash += buf[p++].toString(16).padStart(2, "0");
  if (hash !== schemaHash) return { ok: false, refused: `wire schema ${hash} differs from this build's ${schemaHash}: STATUS cannot be decoded`, hash };
  const wireMajor = dv.getUint16(p, true); p += 2; const wireMinor = dv.getUint16(p, true); p += 2;
  const sampleRate = dv.getUint32(p, true); p += 4;
  const quantumFrames = dv.getUint16(p, true); p += 2;
  const statusEveryQuanta = buf[p++]; const preset = buf[p++];
  const startDateMs = dv.getFloat64(p, true); p += 8;
  const keyframeUs = dv.getUint32(p, true); p += 4;
  const jl = dv.getUint32(p, true); p += 4;
  const tables = JSON.parse(new TextDecoder().decode(buf.subarray(p, p + jl))); p += jl;
  return { ok: true, version, flags, hash, wireMajor, wireMinor, sampleRate, quantumFrames, statusEveryQuanta, preset, startDateMs, keyframeUs, tables, bodyOffset: p };
}
