// Runs in Chromium (bundled by `referencePage.ts` and added to a blank page): renders a parity scene through an
// `OfflineAudioContext` with the reference graph (`src/plugins/audio/testing/webAudioReference.ts`). Plain data in
// and out: the clips arrive as base64 f32 and the result leaves as base64 f32, so nothing crosses as a live object.
import { BusGraph } from "../../../src/plugins/audio/testing/webAudioReference";
import type { ResolvedBus } from "../../../src/engine/audio/mixer";

export interface ReferencePayload {
  rate: number;
  prerollFrames: number;
  frames: number;
  /** Per clip, per channel, base64 of the planar f32 samples. */
  clips: string[][];
  buses: ResolvedBus[];
  voices: { clip: number; bus: string; gain: number; spatial: { dir: [number, number, number]; panner: "equalpower" | "hrtf" } | null }[];
}

export interface ReferenceResult {
  left: string;
  right: string;
  userAgent: string;
}

function fromBase64(text: string): Float32Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function toBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function render(payload: ReferencePayload): Promise<ReferenceResult> {
  const { rate, prerollFrames, frames } = payload;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: prerollFrames + frames, sampleRate: rate });
  const graph = new BusGraph(ctx, ctx.destination, { resolveAll: () => payload.buses } as never, { immediate: true });
  const buffers = payload.clips.map((channels) => {
    const data = channels.map(fromBase64);
    const buffer = ctx.createBuffer(data.length, data[0]!.length, rate);
    data.forEach((d, c) => buffer.copyToChannel(d as Float32Array<ArrayBuffer>, c));
    return buffer;
  });
  for (const v of payload.voices) {
    const source = ctx.createBufferSource();
    source.buffer = buffers[v.clip]!;
    let tail: AudioNode = source;
    if (v.gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = v.gain;
      tail.connect(g);
      tail = g;
    }
    if (v.spatial) {
      // Listener-space direction at distance 1: the default (inverse) distance model gives gain 1, and the cone is open.
      const panner = ctx.createPanner();
      panner.panningModel = v.spatial.panner === "hrtf" ? "HRTF" : "equalpower";
      panner.positionX.value = v.spatial.dir[0];
      panner.positionY.value = v.spatial.dir[1];
      panner.positionZ.value = v.spatial.dir[2];
      tail.connect(panner);
      tail = panner;
    }
    tail.connect(graph.input(v.bus));
    source.start(prerollFrames / rate);
  }
  const out = await ctx.startRendering();
  return {
    left: toBase64(out.getChannelData(0).slice(prerollFrames)),
    right: toBase64(out.getChannelData(1).slice(prerollFrames)),
    userAgent: navigator.userAgent,
  };
}

(globalThis as unknown as { MycoParity: { render: typeof render } }).MycoParity = { render };
