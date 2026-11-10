// Mirrors native/audio/crates/audio-decode/tests/loop_points.rs (fixtures built in code), plus the Ogg reader.
import { describe, expect, it } from "vitest";
import {
  type CommentPair,
  commentLoopPoints,
  oggComments,
  readLoopPoints,
  smplLoopPoints,
  wavLoopPoints,
} from "./loopPointsReader";

// ---- byte builders ----

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length % 2 === 1 ? [0] : [];
  return concat([enc(id), Uint8Array.from(u32(body.length)), body, Uint8Array.from(pad)]);
}

function fmtChunk(): Uint8Array {
  const body = Uint8Array.from([
    1, 0, // PCM
    1, 0, // mono
    ...u32(8000),
    ...u32(16000),
    2, 0,
    16, 0,
  ]);
  return chunk("fmt ", body);
}

function dataChunk(): Uint8Array {
  return chunk("data", new Uint8Array(400));
}

/** `smpl` body with the given `[type, start, end]` loops. */
function smplBody(loops: readonly (readonly [number, number, number])[]): Uint8Array {
  const bytes: number[] = new Array<number>(28).fill(0);
  bytes.push(...u32(loops.length), ...u32(0)); // numSampleLoops, samplerData
  loops.forEach(([type, start, end], i) => {
    for (const v of [i, type, start, end, 0, 0]) bytes.push(...u32(v));
  });
  return Uint8Array.from(bytes);
}

function riff(chunks: readonly Uint8Array[]): Uint8Array {
  const body = concat([enc("WAVE"), ...chunks]);
  return concat([enc("RIFF"), Uint8Array.from(u32(body.length)), body]);
}

// Ogg: a page is built from pieces; a piece is a whole packet or the start of one that continues on the next page.

interface Piece {
  readonly data: Uint8Array;
  readonly last: boolean;
}

/** A packet that ends in this piece. */
const whole = (data: Uint8Array): Piece => ({ data, last: true });
/** The start of a packet that continues on the next page: its length must be a multiple of 255. */
const part = (data: Uint8Array): Piece => ({ data, last: false });

interface OggPage {
  readonly serial?: number;
  readonly continued?: boolean;
  readonly pieces: readonly Piece[];
}

const SERIAL = 0x1234;

function lacingFor(length: number): number[] {
  const lacing: number[] = [];
  let remaining = length;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  lacing.push(remaining);
  return lacing;
}

function oggPage(page: OggPage): Uint8Array {
  const lacing: number[] = [];
  for (const piece of page.pieces) {
    if (piece.last) {
      lacing.push(...lacingFor(piece.data.length));
    } else {
      if (piece.data.length % 255 !== 0) throw new Error("a continued piece must be a multiple of 255 bytes");
      for (let i = 0; i < piece.data.length / 255; i++) lacing.push(255);
    }
  }
  const header = new Uint8Array(27 + lacing.length);
  header.set(enc("OggS"), 0);
  header[4] = 0; // version
  header[5] = page.continued ? 0x01 : 0x00;
  header.set(u32(page.serial ?? SERIAL), 14);
  header[26] = lacing.length;
  header.set(lacing, 27);
  return concat([header, ...page.pieces.map((p) => p.data)]);
}

function ogg(...pages: readonly OggPage[]): Uint8Array {
  return concat(pages.map(oggPage));
}

const vorbisIdentification = (): Uint8Array => concat([Uint8Array.of(0x01), enc("vorbis"), new Uint8Array(23)]);
const opusHead = (): Uint8Array => concat([enc("OpusHead"), new Uint8Array(11)]);

/** A comment header packet: prefix, vendor, count (`declaredCount` overrides it), then `KEY=value` entries. */
function commentPacket(prefix: string, comments: readonly string[], declaredCount = comments.length): Uint8Array {
  const parts: Uint8Array[] = [enc(prefix), Uint8Array.from(u32(4)), enc("test"), Uint8Array.from(u32(declaredCount))];
  for (const comment of comments) {
    const bytes = enc(comment);
    parts.push(Uint8Array.from(u32(bytes.length)), bytes);
  }
  return concat(parts);
}

const vorbisComments = (comments: readonly string[]): Uint8Array =>
  concat([commentPacket("\x03vorbis", comments), Uint8Array.of(0x01)]); // trailing framing bit
const opusTags = (comments: readonly string[]): Uint8Array => commentPacket("OpusTags", comments);

/** A Vorbis file whose identification and comment header share one page. */
function vorbisOnePage(comments: readonly string[]): Uint8Array {
  return ogg({ pieces: [whole(vorbisIdentification()), whole(vorbisComments(comments))] });
}

/** A valid WAV fixture: `smpl` after `data`, one forward loop `[10, 99]`. */
const wavFixture = (): Uint8Array => riff([fmtChunk(), dataChunk(), chunk("smpl", smplBody([[0, 10, 99]]))]);

/** A valid Ogg fixture: two pages, the comment header last. */
const oggFixture = (): Uint8Array =>
  ogg({ pieces: [whole(vorbisIdentification())] }, { pieces: [whole(vorbisComments(["LOOPSTART=10", "LOOPLENGTH=20"]))] });

// Deterministic xorshift, so the random-input test is reproducible.
function makeRandom(seed: number): { byte: () => number; word: () => number } {
  let state = seed | 0 || 1;
  const word = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return { byte: () => word() & 0xff, word };
}

describe("wavLoopPoints", () => {
  it("wav_smpl_after_data", () => {
    const f = riff([fmtChunk(), dataChunk(), chunk("smpl", smplBody([[0, 10, 99]]))]);
    expect(wavLoopPoints(f)).toEqual({ start: 10, end: 100 });
  });

  it("wav_smpl_before_data", () => {
    const f = riff([fmtChunk(), chunk("smpl", smplBody([[0, 5, 149]])), dataChunk()]);
    expect(wavLoopPoints(f)).toEqual({ start: 5, end: 150 });
  });

  it("wav_without_smpl_or_loops", () => {
    expect(wavLoopPoints(riff([fmtChunk(), dataChunk()]))).toBeNull();
    const f = riff([fmtChunk(), dataChunk(), chunk("smpl", smplBody([]))]);
    expect(wavLoopPoints(f)).toBeNull();
  });

  it("wav_not_riff_or_empty", () => {
    expect(wavLoopPoints(new Uint8Array())).toBeNull();
    expect(wavLoopPoints(enc("RIFF"))).toBeNull();
    expect(wavLoopPoints(enc("OggS0000000000000000"))).toBeNull();
  });

  it("wav_odd_sized_chunk_before_smpl_is_padded", () => {
    const f = riff([
      fmtChunk(),
      chunk("junk", Uint8Array.of(1, 2, 3)),
      dataChunk(),
      chunk("smpl", smplBody([[0, 1, 2]])),
    ]);
    expect(wavLoopPoints(f)).toEqual({ start: 1, end: 3 });
  });

  it("wav_truncated_smpl_chunk_is_none", () => {
    const f = riff([fmtChunk(), dataChunk(), chunk("smpl", smplBody([[0, 10, 99]]))]);
    expect(wavLoopPoints(f.subarray(0, f.length - 10))).toBeNull();
  });
});

describe("smplLoopPoints", () => {
  it("smpl_first_forward_loop_wins", () => {
    expect(smplLoopPoints(smplBody([[0, 100, 199], [0, 300, 399]]))).toEqual({ start: 100, end: 200 });
  });

  it("smpl_skips_non_forward_loops", () => {
    expect(smplLoopPoints(smplBody([[1, 0, 50]]))).toBeNull();
    expect(smplLoopPoints(smplBody([[2, 0, 50]]))).toBeNull();
    expect(smplLoopPoints(smplBody([[1, 0, 50], [0, 7, 8]]))).toEqual({ start: 7, end: 9 });
  });

  it("smpl_end_before_start_or_overflow_is_skipped", () => {
    expect(smplLoopPoints(smplBody([[0, 50, 10]]))).toBeNull();
    expect(smplLoopPoints(smplBody([[0, 0, 0xffffffff], [0, 1, 2]]))).toEqual({ start: 1, end: 3 });
  });

  it("smpl_malformed_short_chunk", () => {
    expect(smplLoopPoints(new Uint8Array())).toBeNull();
    expect(smplLoopPoints(new Uint8Array(35))).toBeNull();
    // Header says 2 loops but only 1 complete record follows: the complete one still counts.
    const two = Uint8Array.from([...smplBody([[0, 4, 9]]), ...new Uint8Array(10)]);
    two.set(u32(2), 28);
    expect(smplLoopPoints(two)).toEqual({ start: 4, end: 10 });
    // Header says 1 loop, the record is cut short.
    expect(smplLoopPoints(smplBody([[0, 4, 9]]).subarray(0, 36 + 20))).toBeNull();
  });
});

describe("commentLoopPoints", () => {
  it("comments_start_and_length", () => {
    expect(commentLoopPoints([["LOOPSTART", "1000"], ["LOOPLENGTH", "500"]])).toEqual({ start: 1000, end: 1500 });
  });

  it("comments_mixed_case_keys_and_other_keys", () => {
    const c: CommentPair[] = [["TITLE", "x"], ["LoopLength", " 40 "], ["loopstart", "10"]];
    expect(commentLoopPoints(c)).toEqual({ start: 10, end: 50 });
  });

  it("comments_missing_length_or_start", () => {
    expect(commentLoopPoints([["LOOPSTART", "10"]])).toBeNull();
    expect(commentLoopPoints([["LOOPLENGTH", "10"]])).toBeNull();
    expect(commentLoopPoints([])).toBeNull();
  });

  it("comments_non_numeric_zero_or_overflow", () => {
    expect(commentLoopPoints([["LOOPSTART", "abc"], ["LOOPLENGTH", "5"]])).toBeNull();
    expect(commentLoopPoints([["LOOPSTART", "5"], ["LOOPLENGTH", "-1"]])).toBeNull();
    expect(commentLoopPoints([["LOOPSTART", "5"], ["LOOPLENGTH", "0"]])).toBeNull();
    expect(commentLoopPoints([["LOOPSTART", "4294967295"], ["LOOPLENGTH", "1"]])).toBeNull();
    // The first of each key is used even when its value does not parse.
    expect(commentLoopPoints([["LOOPSTART", "x"], ["LOOPSTART", "5"], ["LOOPLENGTH", "5"]])).toBeNull();
  });
});

describe("oggComments", () => {
  it("vorbis_comment_header_in_one_page", () => {
    const f = vorbisOnePage(["TITLE=Intro", "LOOPSTART=10", "LOOPLENGTH=20"]);
    expect(oggComments(f)).toEqual([
      ["TITLE", "Intro"],
      ["LOOPSTART", "10"],
      ["LOOPLENGTH", "20"],
    ]);
    expect(commentLoopPoints(oggComments(f))).toEqual({ start: 10, end: 30 });
  });

  it("opus_tags_in_one_page", () => {
    const f = ogg({
      pieces: [whole(opusHead()), whole(opusTags(["LOOPSTART=3", "NOTE", "A=b=c", "LOOPLENGTH=4"]))],
    });
    // A comment without `=` is dropped; the split is at the first `=`.
    expect(oggComments(f)).toEqual([
      ["LOOPSTART", "3"],
      ["A", "b=c"],
      ["LOOPLENGTH", "4"],
    ]);
  });

  it("comment_packet_spanning_two_pages", () => {
    const comments = ["TITLE=" + "a".repeat(600), "LOOPSTART=5", "LOOPLENGTH=6"];
    const packet = vorbisComments(comments);
    expect(packet.length).toBeGreaterThan(510);
    const f = ogg(
      // The first 510 bytes (two full 255-byte lacings) end the page with the packet still open.
      { pieces: [whole(vorbisIdentification()), part(packet.subarray(0, 510))] },
      { continued: true, pieces: [whole(packet.subarray(510))] },
    );
    expect(oggComments(f)).toEqual([
      ["TITLE", "a".repeat(600)],
      ["LOOPSTART", "5"],
      ["LOOPLENGTH", "6"],
    ]);
  });

  it("other_serial_pages_are_ignored", () => {
    const f = ogg(
      { pieces: [whole(vorbisIdentification())] },
      { serial: 0x9999, pieces: [whole(commentPacket("\x03vorbis", ["LOOPSTART=999"]))] },
      { serial: 0x9999, continued: true, pieces: [whole(enc("junk"))] },
      { pieces: [whole(vorbisComments(["LOOPSTART=1", "LOOPLENGTH=2"]))] },
    );
    expect(oggComments(f)).toEqual([
      ["LOOPSTART", "1"],
      ["LOOPLENGTH", "2"],
    ]);
  });

  it("not_ogg_truncated_or_malformed_gives_no_comments", () => {
    // Not Ogg at all.
    expect(oggComments(new Uint8Array())).toEqual([]);
    expect(oggComments(wavFixture())).toEqual([]);
    expect(oggComments(enc("ID3\x03\x00\x00\x00\x00\x00\x00"))).toEqual([]);

    // Every truncation of a valid file has no comment header; the whole file has one.
    const valid = oggFixture();
    expect(oggComments(valid)).toHaveLength(2);
    for (let n = 0; n < valid.length; n++) {
      expect(oggComments(valid.subarray(0, n))).toEqual([]);
    }

    const page1Length = oggPage({ pieces: [whole(vorbisIdentification())] }).length;

    // Corrupted capture pattern on the second page.
    const badCapture = valid.slice();
    badCapture[page1Length] = "X".charCodeAt(0);
    expect(oggComments(badCapture)).toEqual([]);

    // Unsupported page version.
    const badVersion = valid.slice();
    badVersion[page1Length + 4] = 1;
    expect(oggComments(badVersion)).toEqual([]);

    // The comment header is missing.
    expect(oggComments(ogg({ pieces: [whole(vorbisIdentification())] }))).toEqual([]);

    // Unknown first packet, and a comment header whose prefix does not match the codec.
    expect(oggComments(ogg({ pieces: [whole(enc("\x7fFLAC"))] }, { pieces: [whole(vorbisComments(["A=1"]))] }))).toEqual([]);
    expect(oggComments(ogg({ pieces: [whole(opusHead())] }, { pieces: [whole(vorbisComments(["A=1"]))] }))).toEqual([]);
    expect(
      oggComments(ogg({ pieces: [whole(vorbisIdentification())] }, { pieces: [whole(commentPacket("\x03vorbiz", ["A=1"]))] })),
    ).toEqual([]);

    // Declared count larger than the comments present.
    expect(
      oggComments(
        ogg({ pieces: [whole(vorbisIdentification())] }, { pieces: [whole(commentPacket("\x03vorbis", ["A=1", "B=2"], 3))] }),
      ),
    ).toEqual([]);

    // A comment length that runs past the end of the packet.
    const overlong = concat([
      enc("\x03vorbis"),
      Uint8Array.from(u32(4)),
      enc("test"),
      Uint8Array.from(u32(1)),
      Uint8Array.from(u32(100)),
      enc("abc"),
    ]);
    expect(oggComments(ogg({ pieces: [whole(vorbisIdentification())] }, { pieces: [whole(overlong)] }))).toEqual([]);

    // A continuation flag on a page that does not continue a packet.
    expect(
      oggComments(ogg({ pieces: [whole(vorbisIdentification())] }, { continued: true, pieces: [whole(vorbisComments(["A=1"]))] })),
    ).toEqual([]);
  });

  it("comment_packet_over_4_mib_gives_no_comments", () => {
    // A complete, valid comment header of just over 4 MiB: the reader stops at the cap instead.
    const packet = commentPacket("\x03vorbis", ["TITLE=" + "a".repeat(4 * 1024 * 1024)]);
    const chunkSize = 255 * 255; // one full page of 255 lacings
    const pages: OggPage[] = [{ pieces: [whole(vorbisIdentification())] }];
    let at = 0;
    while (packet.length - at > chunkSize) {
      pages.push({ continued: at > 0, pieces: [part(packet.subarray(at, at + chunkSize))] });
      at += chunkSize;
    }
    pages.push({ continued: true, pieces: [whole(packet.subarray(at))] });
    expect(oggComments(ogg(...pages))).toEqual([]);
  });
});

describe("readLoopPoints", () => {
  it("dispatches_wav_and_ogg_and_ignores_other_formats", () => {
    expect(readLoopPoints(wavFixture())).toEqual({ start: 10, end: 100 });
    expect(readLoopPoints(oggFixture())).toEqual({ start: 10, end: 30 });
    expect(readLoopPoints(new Uint8Array())).toBeNull();
    expect(readLoopPoints(enc("ID3\x04\x00\x00\x00\x00\x00\x00"))).toBeNull();
    expect(readLoopPoints(concat([enc("\x00\x00\x00\x18ftypmp42"), new Uint8Array(20)]))).toBeNull();
    // RIFX and RF64 are not read, even with a valid smpl chunk.
    const rifx = wavFixture();
    rifx.set(enc("RIFX"), 0);
    expect(readLoopPoints(rifx)).toBeNull();
    const rf64 = wavFixture();
    rf64.set(enc("RF64"), 0);
    expect(readLoopPoints(rf64)).toBeNull();
    // An Ogg file without loop comments.
    expect(readLoopPoints(vorbisOnePage(["TITLE=x"]))).toBeNull();
  });

  it("never_throws_on_truncations_of_a_valid_file", () => {
    for (const file of [wavFixture(), oggFixture()]) {
      expect(readLoopPoints(file)).not.toBeNull();
      for (let n = 0; n < file.length; n++) {
        expect(readLoopPoints(file.subarray(0, n))).toBeNull();
      }
    }

    const random = makeRandom(0x2545f491);
    const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => random.byte());
    const riffHead = concat([enc("RIFF"), Uint8Array.from(u32(0)), enc("WAVE")]);
    for (let i = 0; i < 2000; i++) {
      const body = randomBytes(random.word() % 300);
      const inputs = [body, concat([riffHead, body]), concat([enc("OggS"), body])];
      for (const input of inputs) {
        expect(() => readLoopPoints(input)).not.toThrow();
        expect(() => wavLoopPoints(input)).not.toThrow();
        expect(() => smplLoopPoints(input)).not.toThrow();
        expect(() => commentLoopPoints(oggComments(input))).not.toThrow();
        const result = readLoopPoints(input);
        if (result !== null) {
          expect(Number.isInteger(result.start) && Number.isInteger(result.end)).toBe(true);
          expect(result.start).toBeGreaterThanOrEqual(0);
          expect(result.end).toBeGreaterThan(result.start);
          expect(result.end).toBeLessThanOrEqual(0xffffffff);
        }
      }
    }
  });
});
