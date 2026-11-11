// The "core" side of the harness: renders a beat grid (no audio content needed: the clock is what we measure) and
// mimics the engine worklet's STATUS cadence (every STATUS_EVERY_QUANTA = 6 quanta, coreDriver.ts:900-903; Date.now stamp).
// Design B's event is carried two ways: with the next STATUS ("status") and as an immediate message ("imm").
// Sample accuracy: a beat is emitted in the quantum that contains its frame; epochs switch at an exact frame.
import { beatFrame } from './tempo.js';
const QUANTUM = 128, STATUS_EVERY = 6;
class Beats extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.sr = p.sr;
    this.clk = new Float64Array(p.sab); // epoch ms from a spinning worker (worklet has no performance)
    this.cur = null; this.nextBeat = 0; this.pending = null;
    this.sinceStatus = 0; this.statusBeats = []; this.statusEpochs = [];
    this.rendered = [];            // [epoch id, beat, frame] ground truth: what the core rendered
    this.qf = []; this.qt = [];    // per quantum: context frame, spinner epoch ms
    this.late = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
    this.cpu = { n: 0, max: 0 };
  }
  onMsg(m) {
    if (m.type === 'seg') this.pending = { id: m.id, map: m.map, S: m.S, asap: m.S === 0 }; // S === 0: asap (the core picks the frame)
    else if (m.type === 'dump') {
      this.port.postMessage({ type: 'dump', rendered: this.rendered, qf: this.qf, qt: this.qt, late: this.late });
    }
  }
  process() {
    const q0 = currentFrame, q1 = q0 + QUANTUM;
    this.qf.push(q0); this.qt.push(this.clk[0]);
    const pend = this.pending;
    if (pend && (pend.asap || pend.S < q1)) {
      if (pend.asap) pend.S = q0;            // applied at this quantum's first frame (the core's choice)
      else if (pend.S < q0) { this.late++; pend.S = q0; }
      // beats of the old epoch before the switch frame
      this.emitUntil(Math.min(pend.S, q1));
      this.cur = pend; this.nextBeat = 0; this.pending = null;
      this.statusEpochs.push([pend.id, pend.S]);
      this.port.postMessage({ type: 'epoch', id: pend.id, S: pend.S, asap: pend.asap });
    }
    this.emitUntil(q1);
    if (++this.sinceStatus >= STATUS_EVERY) {
      this.sinceStatus = 0;
      this.port.postMessage({ type: 'status', frame: q1, dateMs: Date.now(), beats: this.statusBeats, epochs: this.statusEpochs });
      this.statusBeats = []; this.statusEpochs = [];
    }
    return true;
  }
  emitUntil(limit) {
    const c = this.cur; if (!c) return;
    for (;;) {
      const f = beatFrame(c.map, c.S, this.nextBeat, this.sr);
      if (f >= limit) break;
      this.rendered.push([c.id, this.nextBeat, f]);
      this.statusBeats.push([c.id, this.nextBeat, f]);
      this.port.postMessage({ type: 'beat', id: c.id, n: this.nextBeat, frame: f });
      this.nextBeat++;
    }
  }
}
registerProcessor('beats', Beats);
