// Tests for tools/makeMusic.mjs. Run: node --test tools/makeMusic.test.mjs (or `npm run test:tools`).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAR, BPM, CLIPS, DEFAULT_OUT, RATE, checkAll, render, renderAll, wavBytes, writeAll } from "./makeMusic.mjs";

/** The header of a mono 16-bit PCM WAV as written here: `{ rate, channels, bits, frames }`. */
function header(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(bytes.toString("ascii", 36, 40), "data");
  const data = bytes.readUInt32LE(40);
  assert.equal(bytes.length, 44 + data);
  assert.equal(bytes.readUInt32LE(4), 36 + data);
  return { rate: bytes.readUInt32LE(24), channels: bytes.readUInt16LE(22), bits: bytes.readUInt16LE(34), frames: data / 2 };
}

const samplesOf = (bytes) => Float32Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + i * 2) / 32768);

test("wavBytes: header, clamping and rounding", () => {
  const b = wavBytes(Float32Array.from([0, 0.5, -0.5, 2, -2]));
  assert.deepEqual(header(b), { rate: RATE, channels: 1, bits: 16, frames: 5 });
  assert.deepEqual([...samplesOf(b)].map((x) => Math.round(x * 100)), [0, 50, -50, 100, -100]);
});

test("every clip is a mono 16-bit WAV whose length is its whole bars at 120 bpm", () => {
  assert.equal(BPM, 120);
  assert.equal(BAR, 2);
  for (const clip of CLIPS) {
    const h = header(wavBytes(clip.make()));
    assert.equal(h.rate, RATE, clip.name);
    assert.equal(h.frames, Math.round(clip.bars * BAR * RATE), `${clip.name} holds ${clip.bars} bars`);
  }
});

test("clips are audible, not clipped, and each starts and ends sensibly", () => {
  for (const clip of CLIPS) {
    const s = clip.make();
    let peak = 0;
    let sq = 0;
    for (const x of s) {
      assert.ok(Number.isFinite(x), `${clip.name}: finite`);
      peak = Math.max(peak, Math.abs(x));
      sq += x * x;
    }
    assert.ok(peak > 0.3 && peak <= 0.85, `${clip.name}: peak ${peak}`);
    assert.ok(Math.sqrt(sq / s.length) > 0.02, `${clip.name}: not near-silent`);
    if (!clip.loop) assert.ok(Math.abs(s[s.length - 1]) < 0.01, `${clip.name}: ends at rest`);
  }
});

test("the same segment's stems are exactly the same length", () => {
  const frames = (name) => render(name).length;
  assert.equal(frames("explore-pad"), frames("explore-arp"));
  assert.equal(frames("combat-drums"), frames("combat-bass"));
  assert.equal(frames("calm-pad"), frames("calm-bells"));
  // all three switch children are the same length, so a change at a bar keeps the grid
  assert.equal(frames("explore-pad"), frames("combat-drums"));
  assert.equal(frames("explore-pad"), frames("calm-pad"));
});

test("looping clips close their loop: no jump from the last sample to the first", () => {
  for (const clip of CLIPS.filter((c) => c.loop)) {
    const s = clip.make();
    // the step across the seam is no bigger than the steps inside the clip
    let biggest = 0;
    for (let i = 1; i < s.length; i++) biggest = Math.max(biggest, Math.abs(s[i] - s[i - 1]));
    const seam = Math.abs(s[0] - s[s.length - 1]);
    assert.ok(seam <= biggest, `${clip.name}: seam ${seam} against the largest step ${biggest}`);
  }
});

test("the loop-exit clip carries a tail: loud at the loop end, ringing out to silence", () => {
  const s = render("loop-body");
  const at = (seconds) => Math.round(seconds * RATE);
  const rms = (a, b) => Math.sqrt(s.slice(at(a), at(b)).reduce((n, x) => n + x * x, 0) / (at(b) - at(a)));
  assert.equal(s.length, at(3 * BAR));
  assert.ok(rms(2 * BAR, 2 * BAR + 0.2) > rms(0, 0.2) * 0.8, "the crash and chord start at bar 3");
  assert.ok(rms(3 * BAR - 0.2, 3 * BAR) < rms(2 * BAR, 2 * BAR + 0.2) * 0.3, "the tail dies away");
});

test("the combat drums are broadband and the calm pad is not (so a crossfade curve is audible)", () => {
  const brightness = (s) => {
    let d = 0;
    let e = 0;
    for (let i = 1; i < s.length; i++) {
      d += (s[i] - s[i - 1]) ** 2;
      e += s[i] ** 2;
    }
    return d / e;
  };
  assert.ok(brightness(render("combat-drums")) > 10 * brightness(render("calm-pad")));
});

test("deterministic: two renders are byte-identical, and the written files match", () => {
  const a = renderAll();
  const b = renderAll();
  assert.equal(a.length, CLIPS.length);
  a.forEach((f, i) => assert.ok(f.bytes.equals(b[i].bytes), f.file));
  const dir = mkdtempSync(join(tmpdir(), "make-music-"));
  try {
    writeAll(dir);
    assert.deepEqual(readdirSync(dir).sort(), a.map((f) => f.file).sort());
    for (const f of a) assert.ok(readFileSync(join(dir, f.file)).equals(f.bytes), `${f.file} on disk`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed sample clips are what the generator writes", () => {
  assert.deepEqual(checkAll(DEFAULT_OUT), []);
});

/** Clips the sound-lab events use that another generator writes, with that generator. */
const OTHER_GENERATORS = new Map([["audio/music/click-track.wav", "samples/sound-lab/tools/makeClick.mjs"]]);

test("the sound-lab events name only clips the generator makes, with matching lengths", () => {
  const dir = DEFAULT_OUT;
  const have = new Map(CLIPS.map((c) => [`audio/music/${c.name}.wav`, c]));
  const events = readdirSync(dir).filter((f) => f.endsWith(".audioevent.json"));
  assert.ok(events.length >= 3);
  const used = new Set();
  const segments = (node, out = []) => {
    if (node.type === "segment") out.push(node);
    for (const c of [...(node.children ?? []), ...(node.library ?? [])]) segments(c, out);
    return out;
  };
  for (const file of events) {
    const event = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const seg of segments(event.root)) {
      const lengths = new Set();
      for (const t of seg.tracks) {
        // Clips from another generator (Rh3's click track, `samples/sound-lab/tools/makeClick.mjs`): committed, and not on
        // this generator's lengths.
        if (OTHER_GENERATORS.has(t.clip)) {
          assert.ok(existsSync(join(dir, "..", "..", t.clip)), `${file}: ${t.clip} (${OTHER_GENERATORS.get(t.clip)}) is committed`);
          continue;
        }
        const clip = have.get(t.clip);
        assert.ok(clip, `${file}: ${t.clip} is not a generated clip`);
        used.add(t.clip);
        lengths.add(clip.bars);
      }
      if (lengths.size === 0) continue; // only other generators' clips
      assert.equal(lengths.size, 1, `${file}: segment ${seg.id}'s stems differ in length`);
      assert.ok(seg.tempo.every((m) => m.bpm === BPM && m.beatsPerBar === 4), `${file}: ${seg.id} is on the shared grid`);
    }
  }
  assert.deepEqual([...used].sort(), [...have.keys()].sort(), "every generated clip is used by an event");
});
