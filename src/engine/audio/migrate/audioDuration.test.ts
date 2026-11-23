/** `audioFileSeconds`: lengths from WAV, FLAC, Ogg Vorbis, Ogg Opus and MP3 headers, built byte by byte here. */
import { describe, expect, it } from "vitest";
import { audioFileSeconds } from "./audioDuration";

const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array => {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) flat.push(ch.charCodeAt(0));
    else flat.push(...p);
  }
  return Uint8Array.from(flat);
};
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

function wav(frames: number, rate: number, channels = 2): Uint8Array {
  const block = channels * 2;
  const fmt = bytes("fmt ", le32(16), le16(1), le16(channels), le32(rate), le32(rate * block), le16(block), le16(16));
  const data = bytes("data", le32(frames * block), new Uint8Array(frames * block));
  return bytes("RIFF", le32(4 + fmt.length + data.length), "WAVE", fmt, data);
}

function flac(totalSamples: number, rate: number): Uint8Array {
  const info = new Array(34).fill(0);
  info[10] = (rate >> 12) & 255;
  info[11] = (rate >> 4) & 255;
  info[12] = ((rate & 15) << 4) | (1 << 1); // stereo
  info[13] = (15 << 4) | Math.floor(totalSamples / 2 ** 32); // 16 bits per sample, top 4 bits of the count
  info.splice(14, 4, ...be32(totalSamples % 2 ** 32));
  return bytes("fLaC", [0x80, 0, 0, 34], info, new Array(16).fill(0));
}

function oggPage(granule: number, packet: Uint8Array): Uint8Array {
  return bytes("OggS", [0, 0], le32(granule), le32(0), le32(1), le32(0), le32(0), [1, packet.length], packet);
}

function vorbis(samples: number, rate: number): Uint8Array {
  const id = bytes([1], "vorbis", le32(0), [2], le32(rate), le32(0), le32(128000), le32(0), [0xb8, 1]);
  return bytes(oggPage(0, id), oggPage(samples, new Uint8Array(10)));
}

function opus(samples48k: number, preSkip: number): Uint8Array {
  const head = bytes("OpusHead", [1, 2], le16(preSkip), le32(48000), le16(0), [0]);
  return bytes(oggPage(0, head), oggPage(samples48k + preSkip, new Uint8Array(10)));
}

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo: 417-byte frames of 1152 samples. */
const MP3_HEADER = [0xff, 0xfb, 0x90, 0x00];
const FRAME = 417;
function mp3Cbr(frames: number, id3 = false): Uint8Array {
  const frame = bytes(MP3_HEADER, new Uint8Array(FRAME - 4));
  const tag = id3 ? bytes("ID3", [3, 0, 0, 0, 0, 0, 20], new Uint8Array(20)) : new Uint8Array(0);
  return bytes(tag, ...Array.from({ length: frames }, () => frame));
}
function mp3Xing(frames: number): Uint8Array {
  const first = new Uint8Array(FRAME);
  first.set(MP3_HEADER, 0);
  first.set(bytes("Xing", be32(1), be32(frames)), 4 + 32);
  return bytes(first, ...Array.from({ length: 3 }, () => bytes(MP3_HEADER, new Uint8Array(FRAME - 4))));
}

describe("audioFileSeconds", () => {
  it("reads WAV frames over the sample rate", () => {
    expect(audioFileSeconds(wav(22050, 44100))).toBe(0.5);
  });

  it("reads FLAC's STREAMINFO, after an ID3 tag too", () => {
    expect(audioFileSeconds(flac(96000, 48000))).toBe(2);
    expect(audioFileSeconds(bytes("ID3", [4, 0, 0, 0, 0, 0, 4], [0, 0, 0, 0], flac(44100 * 3, 44100)))).toBe(3);
  });

  it("reads Ogg Vorbis and Opus from the last page's granule position", () => {
    expect(audioFileSeconds(vorbis(44100 * 4, 44100))).toBe(4);
    expect(audioFileSeconds(opus(48000 * 1.5, 312))).toBe(1.5);
  });

  it("reads an MP3's Xing frame count, else its constant bitrate over the audio bytes", () => {
    expect(audioFileSeconds(mp3Xing(100))).toBeCloseTo((100 * 1152) / 44100, 9);
    expect(audioFileSeconds(mp3Cbr(50))).toBeCloseTo((50 * FRAME * 8) / 128000, 9);
    expect(audioFileSeconds(mp3Cbr(50, true))).toBeCloseTo((50 * FRAME * 8) / 128000, 9);
  });

  it("gives undefined for what it can't read, and never throws", () => {
    expect(audioFileSeconds(new Uint8Array(0))).toBeUndefined();
    expect(audioFileSeconds(bytes("hello, not audio"))).toBeUndefined();
    expect(audioFileSeconds(bytes("RIFF", le32(4), "WAVE"))).toBeUndefined();
    expect(audioFileSeconds(bytes("fLaC", [0x80, 0, 0, 34]))).toBeUndefined();
    expect(audioFileSeconds(bytes("OggS", new Uint8Array(30)))).toBeUndefined();
    expect(audioFileSeconds(wav(0, 44100))).toBeUndefined();
  });
});
