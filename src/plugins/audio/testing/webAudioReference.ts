/**
 * Test-only reference (ADR 0157 BB2; outside the engine bundle): the Web Audio node graph the pre-0157 mixer
 * built for its buses (ADR 0097), kept so `audioMixer.test.ts` can check what a Web Audio realisation of the mixer does. Per bus: input → effects → snapshot low-pass → gain → parent input.
 * Reverb effects send to one shared convolver whose output goes straight to the destination.
 */
import type { BusEffect } from "../../../engine/audio/settings";
import type { Mixer, ResolvedBus } from "../../../engine/audio/mixer";

interface BusNodes {
  input: GainNode;
  lp: BiquadFilterNode;
  gain: GainNode;
}

/** A synthetic room impulse: decaying stereo noise, so no impulse file ships. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.8, decay = 3): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buf;
}

export class BusGraph {
  private nodes = new Map<string, BusNodes>();
  private reverb: { convolver: ConvolverNode; out: GainNode } | null = null;
  private extra: AudioNode[] = [];

  constructor(private ctx: BaseAudioContext, private destination: AudioNode, mixer: Mixer) {
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
    this.apply(buses);
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
  apply(buses: readonly ResolvedBus[]): void {
    const now = this.ctx.currentTime;
    for (const b of buses) {
      const n = this.nodes.get(b.name);
      if (!n) continue;
      n.gain.gain.setTargetAtTime(b.gain, now, 0.015);
      n.lp.frequency.setTargetAtTime(b.snapshotLowpass ?? 24000, now, 0.015);
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
