// Byte builders for the import-hint tests, from the documented layouts (see importHints.ts). Test support only.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

export const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
export const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
export const f32 = (n: number): number[] => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return [...b];
};

export function concat(parts: readonly (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A RIFF chunk: id, size, body, a pad byte after an odd size. */
export function chunk(id: string, body: Uint8Array | number[]): Uint8Array {
  const pad = body.length % 2 === 1 ? [0] : [];
  return concat([enc(id), u32(body.length), body, pad]);
}

/** A whole RIFF/WAVE file of the given chunks. */
export function wav(chunks: readonly Uint8Array[]): Uint8Array {
  const inner = concat([enc("WAVE"), ...chunks]);
  return concat([enc("RIFF"), u32(inner.length), inner]);
}

/** `fmt ` for 16-bit PCM. */
export const fmtChunk = (rate: number, channels = 2): Uint8Array =>
  chunk("fmt ", [...u16(1), ...u16(channels), ...u32(rate), ...u32(rate * channels * 2), ...u16(channels * 2), ...u16(16)]);

/** `data` of `frames` frames of silence. */
export const dataChunk = (frames: number, channels = 2): Uint8Array => chunk("data", new Uint8Array(frames * channels * 2));

export interface AcidOpts { flags?: number; beats?: number; numerator?: number; denominator?: number; bpm: number }
export const acidBody = (o: AcidOpts): Uint8Array =>
  concat([u32(o.flags ?? 0), u16(60), u16(0), f32(0), u32(o.beats ?? 0), u16(o.denominator ?? 4), u16(o.numerator ?? 4), f32(o.bpm)]);

export const cueBody = (cues: readonly { id: number; frame: number }[]): Uint8Array =>
  concat([u32(cues.length), ...cues.map((c) => concat([u32(c.id), u32(0), enc("data"), u32(0), u32(0), u32(c.frame)]))]);

/** A `LIST adtl` body with `labl` (or `note`) sub-chunks; the text is NUL-terminated. */
export const adtlBody = (labels: readonly { id: number; text: string; kind?: "labl" | "note" }[]): Uint8Array =>
  concat([enc("adtl"), ...labels.map((l) => chunk(l.kind ?? "labl", concat([u32(l.id), enc(l.text), [0]])))]);

export interface SmplLoopRec { type?: number; start: number; end: number; playCount?: number }
export const smplBody = (loops: readonly SmplLoopRec[]): Uint8Array =>
  concat([
    u32(0), u32(0), u32(22675), u32(60), u32(0), u32(0), u32(0), u32(loops.length), u32(0),
    ...loops.map((l, i) => concat([u32(i), u32(l.type ?? 0), u32(l.start), u32(l.end), u32(0), u32(l.playCount ?? 0)])),
  ]);

/** A one-page-per-packet Ogg Vorbis file: identification, comment header, then an empty setup page. */
export function oggVorbis(comments: readonly string[], serial = 1): Uint8Array {
  const page = (seq: number, headerType: number, packet: Uint8Array): Uint8Array => {
    const lacing: number[] = [];
    let left = packet.length;
    while (left >= 255) { lacing.push(255); left -= 255; }
    lacing.push(left);
    return concat([enc("OggS"), [0, headerType], new Array(8).fill(0), u32(serial), u32(seq), u32(0), [lacing.length], lacing, packet]);
  };
  const id = concat([[0x01], enc("vorbis"), new Array(23).fill(0)]);
  const vendor = enc("fixture");
  const body = comments.map((c) => { const t = enc(c); return concat([u32(t.length), t]); });
  const com = concat([[0x03], enc("vorbis"), u32(vendor.length), vendor, u32(comments.length), ...body, [1]]);
  return concat([page(0, 0x02, id), page(1, 0, com), page(2, 0, concat([[0x05], enc("vorbis")]))]);
}
