// ADR 0171 amended by 0172 (M5d, task So1, soak 2; architecture §3.7, §7.3; api-and-models §5): opening a capture of a
// 1,024-voice scene through the Worker. Spike S3's 1,024-live scene (Bn2's `realCore.bench.ts`) runs ten minutes of rendered
// audio through the REAL core on the loopback host into an editor-preset ring (32 MiB, §4.2's largest), wired as
// `capture.ts` wires a recorder: the backend's keyframe source (G7b), the real `EventSink`, META's names merged with the
// sink's interned ones. The ring keeps the newest minutes; the take is saved (`assembleTakeFile`, deflate-raw) and opened
// by the editor's `CaptureSource` on a `node:worker_threads` Worker (real structured clone and transfers). Run alone (about
// 3 to 5 minutes of wall time):
//
//   npx vitest run --config tools/audio-bench/soak.vitest.config.mts captureOpen1024
//
// **Logged, never asserted against wall time (ground rules):** the open, each seek and the ranges, against the design's
// targets (open < 2 s for a 32 MiB ring, seek < 16 ms; §3.7). **Asserted:** the audio clock covered ten minutes; the
// capture opens with the whole kept span; the voice table at five cursor positions (spread over the kept span, each taken
// between keyframes, so the replay is a keyframe plus that second's events) equals the game's voice table at that instant
// (ids, clip and bus names, states, priorities, gains); each seek's work stays within a keyframe interval.
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import { createEventSink, NO_NAME } from "../../runtime/capture/events";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, NAME_TABLES, type CaptureMetaInit } from "../../runtime/capture/format";
import { createRecorder } from "../../runtime/capture/recorder";
import { assembleTakeFile } from "../../runtime/capture/save";
import { FRAME_SECONDS, MiB, RATE, S3_1024, s3Rig, stat, threadWorkerFactory, timedCallOverheadUs, timedSink } from "../../runtime/capture/soakSupport";
import { SAMPLE_META } from "../../runtime/capture/testSupport";
import { VoiceState } from "../../runtime/core/voiceTable";
import { CaptureSource } from "./profilerSource";
import { nameLookup, reconstructVoices } from "./voiceTableModel";

const WARM_SECONDS = 10;
/** Ten minutes; `SO1_SECONDS` shortens it for a shakedown of the harness only. */
const SOAK_SECONDS = Number(process.env.SO1_SECONDS ?? 600);
/** The five cursor positions, as fractions of the run (the ring keeps the newest few minutes: all five fall in it). */
const POSITIONS = [0.62, 0.71, 0.8, 0.9, 0.985];
/** Random seeks timed over the kept span. */
const SEEKS = 200;

interface Truth {
  /** The newest STATUS frame at the instant (the frame the frame's events are stamped at): the cursor's frame. */
  frame: number;
  rows: { id: number; clip: string; bus: string; state: string; priority: number; gain: number }[];
  /**
   * Ids fading out (the table's STOPPING or ENDING, after `stop(fade)`): `Audio.debug()` names them "playing" whatever they
   * were, while the capture keeps the last state its events gave (a virtual voice stopped stays "virtual" until its
   * `voiceStop`). Their ids, clips and buses are compared; their state is not (neither side is wrong).
   */
  fading: Set<number>;
}

let closeWorkers: (() => void) | null = null;
afterAll(() => closeWorkers?.());

function compress(file: Uint8Array): Uint8Array {
  const z = deflateRawSync(file.subarray(CAPTURE_HEADER_BYTES));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + z.byteLength);
  out.set(file.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(z, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

describe("soak 2: a 1,024-voice capture opens through the Worker (§3.7)", () => {
  it("opens, seeks and ranges (timings logged); the voice table at five positions matches the game", async (ctx) => {
    const rig = await s3Rig(S3_1024, 2);
    if (!rig) return ctx.skip();
    const { backend } = rig;
    for (let t = 0; t < WARM_SECONDS; t += FRAME_SECONDS) await rig.frame();

    // The recorder as `capture.ts` wires it, on the editor preset's ring.
    const rec = createRecorder({ preset: "editor" });
    expect(rec.ring.capacity).toBe(32 * MiB);
    const sink = createEventSink(rec, { epochContext: () => ({ sampleRate: RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, frame: backend.debug().core.currentFrame as number }) });
    rec.setKeyframeSource(() => backend.keyframe((table, name) => sink.name(table, name), NO_NAME));
    sink.epoch("start");
    // Main's recorder cost at 1,024 voices with G7b's keyframe source (logged against §7.3's 1 ms/s): the tap timed per
    // block, the sink per call (`timedSink`, whose own cost per call is reported beside it).
    rec.attach(backend);
    const rawTap = backend.recorderTap!;
    let tapMs = 0;
    let keyframeMs = 0;
    backend.recorderTap = (data, byteLength, view) => {
      const kf = rec.lastKeyframeFrame;
      const t0 = performance.now();
      rawTap(data, byteLength, view);
      const dt = performance.now() - t0;
      tapMs += dt;
      if (rec.lastKeyframeFrame !== kf) keyframeMs += dt;
    };
    const sinkTimer = { ms: 0, calls: 0 };
    backend.setProfileSink(timedSink(sink, sinkTimer));
    const startFrame = rec.newestStatusFrame;

    const frames = Math.round(SOAK_SECONDS / FRAME_SECONDS);
    const at = new Set(POSITIONS.map((p) => Math.round(p * frames)));
    const truths: Truth[] = [];
    for (let f = 0; f < frames; f++) {
      await rig.frame(at.has(f) ? () => {
        // The game's table after this frame's main side (its events are stamped at the newest STATUS frame).
        const rows = backend.debug().voices.map((v) => ({ id: v.id, clip: v.clip, bus: v.bus, state: v.state, priority: v.priority, gain: Math.fround(v.gain) }));
        const table = backend.table;
        const fading = new Set<number>();
        for (let i = 0; i < table.capacity; i++) {
          const s = table.state[i]!;
          if (s === VoiceState.STOPPING || s === VoiceState.ENDING) fading.add(((table.gen[i]! << 16) | i) >>> 0);
        }
        truths.push({ frame: rec.newestStatusFrame, rows: rows.sort((p, q) => p.id - q.id), fading });
      } : undefined);
    }
    const seconds = (rec.newestStatusFrame - startFrame) / RATE;
    expect(Math.abs(seconds - SOAK_SECONDS)).toBeLessThan(0.1);
    expect(rec.ring.dropped).toBe(0);
    backend.recorderTap = rawTap;
    rec.detach();
    backend.setProfileSink(null);
    const overheadUs = timedCallOverheadUs();
    const cost = { tap: tapMs / seconds, keyframe: keyframeMs / seconds, sink: sinkTimer.ms / seconds, calls: sinkTimer.calls / seconds, events: sink.eventsWritten / seconds };

    // The save: header, META (the project's buses by slot, plus every name the sink interned: a truncated file's NAMES
    // records may be gone, as `capture.ts`' `withInterned` does), the span, the INDEX; deflate-raw.
    const d = backend.debug();
    const buses: Record<number, string> = {};
    for (const s of d.mix?.slots ?? []) if (s.name !== null && s.state !== "free") buses[s.slot] = s.name;
    const names: CaptureMetaInit["names"] = { ...SAMPLE_META.names, buses };
    NAME_TABLES.forEach((table, t) => {
      if (table === "buses") return;
      const merged: Record<number, string> = {};
      for (const [name, id] of sink.interned[t]!) merged[id] = name;
      names[table] = merged;
    });
    const meta: CaptureMetaInit = { ...SAMPLE_META, audio: JSON.parse(JSON.stringify(mixer.audioSettings)) as unknown, names };
    const span = rec.takeSpan();
    const stored = assembleTakeFile({
      header: { sampleRate: RATE, preset: 2, startDateMs: 1_763_000_000_000, ringBytes: rec.ring.capacity, firstFrame: 0, truncated: rec.truncated },
      meta, span, truncatedFromSeq: rec.truncatedFromSeq,
    });
    const file = compress(stored);

    // Open on a Worker thread through the editor's client.
    const threads = await threadWorkerFactory();
    closeWorkers = threads.close;
    const o0 = performance.now();
    const source = await CaptureSource.openFile(file.slice().buffer, { worker: threads.make() });
    const openMs = performance.now() - o0;
    expect(source.summary.recordCount).toBe(span.recordCount + 1);
    const lookup = nameLookup(source.summary.names);

    // The five positions: the replay equals the game's table.
    const positions: { seconds: number; voices: number; gainOff: number; fading: number; ms: number; scanned: number; fromKeyframe: boolean }[] = [];
    for (const truth of truths) {
      const t = truth.frame / RATE;
      expect(t).toBeGreaterThan(source.startSeconds); // inside the kept span
      const s0 = performance.now();
      const state = await source.seek(t);
      const ms = performance.now() - s0;
      expect(state.keyframe).not.toBeNull();
      const replay = reconstructVoices(state, lookup);
      const rows = replay.rows.map((x) => ({ id: x.id, clip: x.clipName, bus: x.busName, state: x.stateName, priority: x.priority, gain: x.gain })).sort((p, q) => p.id - q.id);
      expect(rows.map((r) => r.id), `ids at ${t.toFixed(3)} s`).toEqual(truth.rows.map((r) => r.id));
      const fade = (r: { id: number; state: string }): string => (truth.fading.has(r.id) ? "fading" : r.state);
      expect(rows.map((r) => [r.clip, r.bus, fade(r)]), `clip, bus, state at ${t.toFixed(3)} s`).toEqual(truth.rows.map((r) => [r.clip, r.bus, fade(r)]));
      // Priority is known for keyframe rows; a voice born after the keyframe carries none (null) in the capture.
      for (let i = 0; i < rows.length; i++) if (rows[i]!.priority !== null) expect(rows[i]!.priority, `priority of ${rows[i]!.id}`).toBe(truth.rows[i]!.priority);
      let gainOff = 0;
      for (let i = 0; i < rows.length; i++) if (Math.fround(rows[i]!.gain) !== truth.rows[i]!.gain) gainOff++;
      expect(gainOff, `gains at ${t.toFixed(3)} s`).toBe(0);
      positions.push({ seconds: t, voices: rows.length, gainOff, fading: truth.fading.size, ms, scanned: state.recordsScanned, fromKeyframe: replay.fromKeyframe });
    }

    // Seek and range timings over the kept span (logged).
    const seekMs: number[] = [];
    const scanned: number[] = [];
    let x = 12345;
    const startS = source.startSeconds;
    const dur = source.duration;
    for (let i = 0; i < SEEKS; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      const t = startS + (x / 4294967296) * dur;
      const s0 = performance.now();
      const st = await source.seek(t);
      seekMs.push(performance.now() - s0);
      scanned.push(st.recordsScanned);
    }
    const columns = ["loadPermille", "mixedVoices", "liveVoices", "workUnits", "underruns"];
    const r0 = performance.now();
    const overview = await source.range(startS, startS + dur, columns, 2000);
    const rangeOverviewMs = performance.now() - r0;
    const r1 = performance.now();
    const raw = await source.range(startS + dur / 2, startS + dur / 2 + 10, columns);
    const rangeRawMs = performance.now() - r1;
    expect(overview.seconds!.length).toBeGreaterThan(0);
    expect(raw.seconds!.length).toBeGreaterThan(600); // 10 s of blocks at 62.5 a second
    // A seek's work is bounded by one keyframe interval of records (plus the disorder window), whatever the capture's length.
    const sc = stat(scanned);
    expect(sc.max).toBeLessThan(source.summary.recordCount / Math.max(1, source.summary.keyframeCount) * 4);
    source.close();

    const sk = stat(seekMs);
    console.log([
      `So1 soak 2, open at 1,024 voices: S3 1,024-live scene through the real core, ${SOAK_SECONDS} s recorded into a ${rec.ring.capacity / MiB} MiB ring, the newest span saved and opened on a Worker thread (container; times logged, targets open < 2 s, seek < 16 ms)`,
      "| measure | value |",
      "|---|---|",
      `| kept span: seconds / records / stored MiB / deflated MiB / truncated | ${dur.toFixed(1)} / ${span.recordCount} / ${(stored.byteLength / MiB).toFixed(2)} / ${(file.byteLength / MiB).toFixed(2)} / ${rec.truncated} |`,
      `| keyframes in the file | ${source.summary.keyframeCount} |`,
      `| main recorder ms per audio s over the ${SOAK_SECONDS} s: tap (of which keyframe blocks) + sink = total (allowance 1 ms) | ${cost.tap.toFixed(3)} (${cost.keyframe.toFixed(3)}) + ${cost.sink.toFixed(3)} = ${(cost.tap + cost.sink).toFixed(3)} |`,
      `| sink calls/s (events/s) x the timing wrapper's own ${overheadUs.toFixed(3)} us = ms/s inside the sink figure | ${cost.calls.toFixed(0)} (${cost.events.toFixed(0)}) x ${overheadUs.toFixed(3)} = ${((cost.calls * overheadUs) / 1000).toFixed(3)} |`,
      `| open through the Worker (ms) | ${openMs.toFixed(0)} |`,
      `| seek, ${SEEKS} random (ms median / p95 / max) | ${sk.median.toFixed(2)} / ${sk.p95.toFixed(2)} / ${sk.max.toFixed(2)} |`,
      `| records scanned per seek (median / p95 / max) | ${sc.median} / ${sc.p95} / ${sc.max} |`,
      `| range, whole span, ${columns.length} columns, 2,000 buckets (ms) | ${rangeOverviewMs.toFixed(1)} |`,
      `| range, 10 s raw (${raw.seconds!.length} samples) (ms) | ${rangeRawMs.toFixed(1)} |`,
      ...positions.map((p, i) => `| position ${i + 1} at ${p.seconds.toFixed(3)} s: voices match (fading, state not compared) / seek ms / records scanned | ${p.voices} rows equal (${p.fading}), gain differs on ${p.gainOff} / ${p.ms.toFixed(2)} / ${p.scanned} |`),
    ].join("\n"));
    rig.dispose();
  });
});
