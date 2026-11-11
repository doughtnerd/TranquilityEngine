// Chromium page harness (Q3). Real parts: decoder.worker.js (the engine's worker entry, unchanged), processor.js (the
// engine's AudioWorklet processor + CoreDriver + myco_audio.wasm), the worker->worklet MessageChannel and the credit
// scheme. Faked part: main's CoreBackend/CoreLink, replaced by ~60 lines that do the same wire calls (INIT of the
// preset, streamPort/connectWorklet, streamOpen, one BATCH with N PLAY records, STATUS read + RECYCLE).
import {
  ASAP,
  BATCH_HEADER_FIXED_END,
  Kind,
  PLAY_FIXED_END,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_STREAM,
  PLAY_FLAGS_WANTS_PLAYHEAD,
  readStatus,
  writeBatchHeader,
  writeEnvelope,
  writePlay,
} from "../../../../src/plugins/audio/runtime/wire.generated";

const RATE = 48_000;
export interface CaseOptions {
  N: number;
  /** The core's `maxMixed` (64 low, 128 default, 256 high): sets the ring count mixed/16 clamped 4..16. */
  mixed: number;
  /** Seconds of audio-clock time to play after the PLAYs. */
  seconds: number;
  /** 0 probe, 1 wav, 2 flac, 3 mp3, 4 ogg */
  hint: number;
  file: string;
  loop: boolean;
  realtime: boolean;
  /** Negative control: terminate the decoder worker this many seconds after the PLAYs (0 = never). The core must report starvation. */
  killWorkerAt?: number;
}

export async function runCase(o: CaseOptions) {
  const [coreWasm, decWasm, fileBytes] = await Promise.all([
    fetch("/myco_audio.wasm").then((r) => r.arrayBuffer()),
    fetch("/myco_audio_decode.wasm").then((r) => r.arrayBuffer()),
    fetch("/" + o.file).then((r) => r.arrayBuffer()),
  ]);
  const frames = Math.round(o.seconds * RATE);
  const ctx: BaseAudioContext = o.realtime ? new AudioContext({ sampleRate: RATE, latencyHint: "interactive" }) : new OfflineAudioContext(2, frames + 4 * RATE, RATE);
  await ctx.audioWorklet.addModule("/processor.js");
  const preset = { maxLogical: 1024, maxMixed: o.mixed, maxBuses: 32, arenaInitialBytes: 16 << 20, clipCeilingBytes: 64 << 20, limiterLookaheadMs: 1.5, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0 };
  const node = new AudioWorkletNode(ctx, "myco-audio-core", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { wasm: coreWasm, preset } });
  node.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  const tbuf = new Float32Array(2048);

  const out = {
    N: o.N, mixed: o.mixed, ringsExpected: Math.min(16, Math.max(4, Math.floor(o.mixed / 16))),
    statusBlocks: 0, starvedVoiceReports: 0, streamEventStarved: 0, streamEventEos: 0, streamEventError: 0,
    starveTimes: [] as number[], underruns: 0, underrunFrames: 0, lateCommands: 0, liveVoicesMax: 0, mixedVoicesMax: 0,
    minSlackFramesMin: 1e9, loadPermillePeak: 0, peakMax: 0, errors: [] as string[], startMs: [] as number[], opened: 0, workerErrors: [] as string[],
    ctxTimeAtPlay: 0, ctxTimeAtEnd: 0, wallMsRun: 0, outPeak: 0, killed: false,
  };
  let seq = 1;
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (d instanceof ArrayBuffer) {
      const v = new DataView(d);
      if (v.getUint16(6, true) === Kind.STATUS) {
        const s = readStatus(d);
        out.statusBlocks++;
        out.starvedVoiceReports += s.starved.length;
        for (const ev of s.streamEvents) {
          if (ev.code === 1) { out.streamEventStarved++; out.starveTimes.push(+(((ctx as AudioContext).currentTime ?? 0)).toFixed(3)); }
          else if (ev.code === 2) out.streamEventEos++;
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
        // RECYCLE hands the STATUS buffer back to the shell's pool; the real link sends the buffer itself.
        const back = d;
        writeEnvelope(new DataView(back), 0, { kind: Kind.RECYCLE, seq: seq++, bodyBytes: 0 });
        node.port.postMessage(back, [back]);
      }
    } else if (d && (d.type === "error" || d.type === "trap")) out.errors.push(d.type + ": " + d.message);
  };

  const worker = new Worker("/decoder.worker.js", { type: "module" });
  const ready = new Promise<void>((res, rej) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") res();
      else if (m.type === "streamOpened") out.opened++;
      else if (m.type === "error") { out.workerErrors.push(m.message); if (m.fatal) rej(new Error(m.message)); }
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
    // One BATCH with N PLAY records (stream voice: `clip` is the stream id), asap.
    const bytes = 16 + BATCH_HEADER_FIXED_END - 16 + o.N * PLAY_FIXED_END;
    const buf = new ArrayBuffer(Math.max(bytes, 64));
    const v = new DataView(buf);
    let pos = BATCH_HEADER_FIXED_END;
    for (let i = 0; i < o.N; i++) {
      pos += writePlay(v, pos, { voiceId: (1 << 16) | i, frameOffset: ASAP, clip: i + 1, bus: 0, flags: PLAY_FLAGS_STREAM | PLAY_FLAGS_WANTS_PLAYHEAD | PLAY_FLAGS_MIXED | (o.loop ? PLAY_FLAGS_LOOP : 0), group: 0, reserved: 0, gain: 0.5 / Math.sqrt(Math.max(1, o.N)), pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 0, score: 1, startOffsetFrames: 0 });
    }
    writeEnvelope(v, 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: pos - 16 });
    writeBatchHeader(v, 0, { firstFrame: 0, count: o.N, flags: 0 });
    node.port.postMessage(buf, [buf]);
    return t0;
  };

  let wall0 = 0;
  if (o.realtime) {
    const ac = ctx as AudioContext;
    await ac.resume();
    // Let the core post its first STATUS and settle, then start the streams.
    await new Promise((r) => setTimeout(r, 500));
    out.ctxTimeAtPlay = ac.currentTime;
    wall0 = performance.now();
    await play();
    await new Promise<void>((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(tbuf);
        for (let i = 0; i < tbuf.length; i++) out.outPeak = Math.max(out.outPeak, Math.abs(tbuf[i]!));
        const el = ac.currentTime - out.ctxTimeAtPlay;
        if (o.killWorkerAt && !out.killed && el >= o.killWorkerAt) { out.killed = true; worker.terminate(); }
        if (el >= o.seconds) resolve(); else setTimeout(tick, 100);
      };
      tick();
    });
    out.ctxTimeAtEnd = ac.currentTime;
    out.wallMsRun = performance.now() - wall0;
  } else {
    // Offline: renders as fast as it can, the worker can't keep up in real time; kept only as a correctness smoke.
    await play();
    await (ctx as OfflineAudioContext).startRendering();
  }
  await new Promise((r) => setTimeout(r, 200));
  worker.terminate();
  if (o.realtime) await (ctx as AudioContext).close();
  if (out.minSlackFramesMin === 1e9) out.minSlackFramesMin = -1;
  return out;
}
(globalThis as unknown as { runCase: typeof runCase }).runCase = runCase;
