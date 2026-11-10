/**
 * Test-only reference (ADR 0157 BB2; outside the engine bundle): the Web Audio node graph the pre-0157 mixer
 * built for its buses (ADR 0097), kept so `audioMixer.test.ts` can check what a Web Audio realisation of the mixer does,
 * and so the parity harness (A2.2c, `tests/e2e/audio-parity/`) can render the same scenes as the core through an
 * `OfflineAudioContext`. Per bus: input → effects → snapshot low-pass → gain → parent input.
 * Reverb effects send to one shared convolver whose output goes straight to the destination.
 *
 * Where the core made a documented choice, this reference makes the same one, so a parity scene compares like with like:
 * - the reverb's impulse is the core's seeded one (`makeImpulse`: mulberry32 seeded 0x4D59434F, the
 *   `audio-dsp/src/convolver/ir.rs` generator bit for bit), fed raw to a normalising `ConvolverNode` (`normalize` is
 *   true by default and is Blink's `reverb.cc` scale, which the core ported);
 * - the snapshot low-pass has Q = 1 dB (the `BiquadFilterNode` default), as the core's.
 * The one difference left is where the reverb return enters: the core adds it before MASTER, this graph sends it to the
 * destination. A scene keeps MASTER at unity, where the two are the same signal.
 */
import type { BusEffect } from "../../../engine/audio/settings";
import type { Mixer, ResolvedBus } from "../../../engine/audio/mixer";

interface BusNodes {
  input: GainNode;
  lp: BiquadFilterNode;
  gain: GainNode;
}

/** The core's impulse seed ("MYCO" in ASCII; `SEED` in `audio-dsp/src/convolver/ir.rs`). */
export const IMPULSE_SEED = 0x4d59434f;

/**
 * A synthetic room impulse: decaying stereo noise, so no impulse file ships. The same samples as the core's
 * (`audio-dsp/src/convolver/ir.rs`): mulberry32 from `IMPULSE_SEED`, channel 0's samples drawn first, then channel 1's,
 * `((u / 2^32) * 2 - 1) * e^3` with `e = 1 - i / length`, computed in doubles and stored as f32. Unscaled: a
 * `ConvolverNode` normalises it itself.
 */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.8, decay = 3): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  let s = IMPULSE_SEED | 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < length; i++) {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      const u = (t ^ (t >>> 14)) >>> 0;
      const e = 1 - i / length;
      // The cube as two multiplications (not `pow`), as the core does it; other exponents use `pow`.
      const noise = (u / 4_294_967_296) * 2 - 1;
      d[i] = decay === 3 ? noise * e * e * e : noise * Math.pow(e, decay);
    }
  }
  return buf;
}

/** What the constructor takes beyond the context, destination and mixer. */
export interface BusGraphOptions {
  /** Set each bus's gain and snapshot cut-off outright instead of easing to them (15 ms time constant). The parity scenes' static mixes use it. */
  immediate?: boolean;
}

export class BusGraph {
  private nodes = new Map<string, BusNodes>();
  private reverb: { convolver: ConvolverNode; out: GainNode } | null = null;
  private extra: AudioNode[] = [];

  constructor(private ctx: BaseAudioContext, private destination: AudioNode, mixer: Pick<Mixer, "resolveAll">, options: BusGraphOptions = {}) {
    const buses = mixer.resolveAll();
    for (const b of buses) {
      const input = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 24000;
      const gain = ctx.createGain();
      this.nodes.set(b.name, { input, lp, gain });
    }
    for (const b of buses) {
      const n = this.nodes.get(b.name)!;
      let tail: AudioNode = n.input;
      for (const fx of b.effects) tail = this.addEffect(fx, tail);
      tail.connect(n.lp);
      n.lp.connect(n.gain);
      n.gain.connect(b.parent ? this.nodes.get(b.parent)!.input : destination);
    }
    this.apply(buses, options.immediate);
  }

  /** The node a sound connects to for a bus (the root if unknown). */
  input(bus: string): AudioNode {
    return (this.nodes.get(bus) ?? [...this.nodes.values()][0]).input;
  }

  private addEffect(fx: BusEffect, from: AudioNode): AudioNode {
    const { ctx } = this;
    switch (fx.type) {
      case "lowpass":
      case "highpass": {
        const f = ctx.createBiquadFilter();
        f.type = fx.type;
        f.frequency.value = fx.frequency;
        f.Q.value = fx.q;
        from.connect(f);
        this.extra.push(f);
        return f;
      }
      case "compressor": {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = fx.threshold;
        c.knee.value = fx.knee;
        c.ratio.value = fx.ratio;
        c.attack.value = fx.attack;
        c.release.value = fx.release;
        from.connect(c);
        this.extra.push(c);
        return c;
      }
      case "reverb": {
        if (!this.reverb) {
          const convolver = ctx.createConvolver();
          convolver.buffer = makeImpulse(ctx);
          const out = ctx.createGain();
          convolver.connect(out);
          out.connect(this.destination);
          this.reverb = { convolver, out };
        }
        const send = ctx.createGain();
        send.gain.value = fx.send;
        from.connect(send);
        send.connect(this.reverb.convolver);
        this.extra.push(send);
        return from; // dry signal continues unchanged
      }
    }
  }

  /** Push the mixer's resolved gains and snapshot cutoffs onto the nodes, smoothed to avoid clicks. */
  apply(buses: readonly ResolvedBus[], immediate = false): void {
    const now = this.ctx.currentTime;
    for (const b of buses) {
      const n = this.nodes.get(b.name);
      if (!n) continue;
      if (immediate) {
        n.gain.gain.value = b.gain;
        n.lp.frequency.value = b.snapshotLowpass ?? 24000;
      } else {
        n.gain.gain.setTargetAtTime(b.gain, now, 0.015);
        n.lp.frequency.setTargetAtTime(b.snapshotLowpass ?? 24000, now, 0.015);
      }
    }
  }

  dispose(): void {
    for (const n of this.nodes.values()) {
      n.input.disconnect(); n.lp.disconnect(); n.gain.disconnect();
    }
    for (const e of this.extra) e.disconnect();
    this.reverb?.convolver.disconnect();
    this.reverb?.out.disconnect();
    this.nodes.clear();
  }
}
