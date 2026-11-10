#!/usr/bin/env node
// Writes audio-decode's test fixtures (task B1) into this directory:
// - the WAV sources, synthesised here (deterministic, no ffmpeg): tones plus a chirp, with fades;
// - FLAC, MP3, Ogg Vorbis and AAC (M4A) encoded from them with ffmpeg (on PATH, with libmp3lame
//   and libvorbis), in bit-exact mode so a rerun with the same ffmpeg gives the same bytes.
// Usage: node native/audio/crates/audio-decode/tests/fixtures/generate.mjs
// tests/decode.rs states what each file must decode to; regenerate both together.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));

/** The WAV sources: name, rate, channels, bits, seconds. */
const SOURCES = [
  { name: "tone-44100-mono", rate: 44100, channels: 1, bits: 16, seconds: 2.0 },
  { name: "tone-48000-stereo", rate: 48000, channels: 2, bits: 16, seconds: 1.0 },
  { name: "tone-22050-stereo-s24", rate: 22050, channels: 2, bits: 24, seconds: 0.5 },
  // B4's loop-seam fixture: no fades and whole cycles only (440/660 Hz left, 330/990 Hz right in 1 s), so the
  // looped source is continuous across the seam and a gap or click there shows.
  { name: "loop-48000-stereo", rate: 48000, channels: 2, bits: 16, seconds: 1.0, loopable: true },
];

/** Sample `i` of channel `c` in [-1, 1): two tones and a 200 Hz to 4 kHz chirp, 10 ms fades. */
function signal(i, c, rate, frames) {
  const t = i / rate;
  const T = frames / rate;
  const f0 = c === 0 ? 440 : 660;
  const chirp = 2 * Math.PI * (200 * t + ((4000 - 200) / (2 * T)) * t * t);
  let s = 0.35 * Math.sin(2 * Math.PI * f0 * t) + 0.15 * Math.sin(2 * Math.PI * f0 * 2.5 * t) + 0.2 * Math.sin(chirp + c);
  const fade = Math.min(1, t / 0.01, (T - t) / 0.01);
  return s * Math.max(0, fade);
}

/** The loopable signal: whole cycles in the clip's length, no fades. */
function loopSignal(i, c, rate) {
  const t = i / rate;
  const [f0, f1] = c === 0 ? [440, 660] : [330, 990];
  return 0.4 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(2 * Math.PI * f1 * t + c);
}

function writeWav({ name, rate, channels, bits, seconds, loopable }) {
  const frames = Math.round(rate * seconds);
  const bytesPerSample = bits / 8;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  const full = 2 ** (bits - 1);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = loopable ? loopSignal(i, c, rate) : signal(i, c, rate, frames);
      const v = Math.max(-full, Math.min(full - 1, Math.round(s * full)));
      if (bits === 16) buf.writeInt16LE(v, o);
      else buf.writeIntLE(v, o, 3);
      o += bytesPerSample;
    }
  }
  writeFileSync(`${dir}${name}.wav`, buf);
  console.log(`${name}.wav: ${frames} frames`);
}

/** Runs ffmpeg on `input` (a file in this directory) with `args`, writing `output`. */
function ffmpeg(input, output, args) {
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", ...args, output],
    { cwd: dir, stdio: "inherit" },
  );
  console.log(output);
}

for (const source of SOURCES) writeWav(source);

// FLAC: lossless, decoded bit-exactly against the WAV.
ffmpeg("tone-44100-mono.wav", "tone-44100-mono.flac", ["-c:a", "flac"]);
ffmpeg("tone-48000-stereo.wav", "tone-48000-stereo.flac", ["-c:a", "flac"]);
ffmpeg("tone-22050-stereo-s24.wav", "tone-22050-stereo-s24.flac", ["-c:a", "flac", "-sample_fmt", "s32"]);

// MP3 (libmp3lame): CBR with a LAME Info header (gapless), VBR with a Xing header, and the same VBR
// without one (MS7's unknown-length check: its length can only be found by decoding it all). The
// ID3v2 tag stays on the first two (the probe must skip it).
ffmpeg("tone-44100-mono.wav", "tone-44100-mono.mp3", ["-c:a", "libmp3lame", "-b:a", "96k"]);
ffmpeg("tone-48000-stereo.wav", "tone-48000-stereo.mp3", ["-c:a", "libmp3lame", "-q:a", "4"]);
ffmpeg("tone-48000-stereo.wav", "tone-48000-stereo-vbr-noxing.mp3", ["-c:a", "libmp3lame", "-q:a", "4", "-write_xing", "0", "-id3v2_version", "0"]);

// Ogg Vorbis (libvorbis).
ffmpeg("tone-44100-mono.wav", "tone-44100-mono.ogg", ["-c:a", "libvorbis", "-q:a", "4"]);
ffmpeg("tone-48000-stereo.wav", "tone-48000-stereo.ogg", ["-c:a", "libvorbis", "-q:a", "4"]);

// AAC-LC in M4A (ffmpeg's encoder, which writes an edit list: 1,024 priming frames), decoded only by the `aac` build.
ffmpeg("tone-44100-mono.wav", "tone-44100-mono.m4a", ["-c:a", "aac", "-b:a", "96k"]);
ffmpeg("tone-48000-stereo.wav", "tone-48000-stereo.m4a", ["-c:a", "aac", "-b:a", "128k"]);

// B4's loop seam: the loopable source in every codec (MP3 CBR with its LAME tag).
ffmpeg("loop-48000-stereo.wav", "loop-48000-stereo.flac", ["-c:a", "flac"]);
ffmpeg("loop-48000-stereo.wav", "loop-48000-stereo.mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]);
ffmpeg("loop-48000-stereo.wav", "loop-48000-stereo.ogg", ["-c:a", "libvorbis", "-q:a", "6"]);
ffmpeg("loop-48000-stereo.wav", "loop-48000-stereo.m4a", ["-c:a", "aac", "-b:a", "192k"]);
