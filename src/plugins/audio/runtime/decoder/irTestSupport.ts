// @internal Test helpers for C2b (Node only; nothing in the engine imports this): a short IR file and a fake worklet port.
import { Kind, readClipBegin, readClipChunk, readClipUnload, readEnvelope } from "../wire.generated";
import type { StreamPortLike } from "./protocol";
import { makeWav } from "./testWav";

/** A decaying noise burst: a plausible short IR, mono or stereo. */
export const ir = (frames: number, channels: number, rate = 48000) =>
  makeWav(frames, channels, rate, (k, c) => Math.round(20000 * Math.exp(-k / (frames / 6)) * Math.sin((k + 1) * (k + 7 + c * 13) * 0.37)));

export interface Kernel {
  rate: number;
  format: number;
  words: number;
  received: number;
  bytes: Uint8Array;
}

/** A worklet end: applies the wire messages it is sent, the way the core's clip registry would. */
export function fakePort() {
  const kernels = new Map<number, Kernel>();
  const log: string[] = [];
  const port: StreamPortLike = {
    onmessage: null,
    postMessage(message) {
      const buffer = message as ArrayBuffer;
      const view = new DataView(buffer);
      const env = readEnvelope(view, 0);
      if (env.kind === Kind.CLIP_BEGIN) {
        const b = readClipBegin(view, 0);
        log.push(`begin ${b.clipId}`);
        kernels.set(b.clipId, { rate: b.sampleRate, format: b.format, words: b.frames, received: 0, bytes: new Uint8Array(b.frames * 4) });
      } else if (env.kind === Kind.CLIP_CHUNK) {
        const c = readClipChunk(view, 0);
        const k = kernels.get(c.clipId)!;
        k.bytes.set(new Uint8Array(buffer, 32, c.frames * 4), c.frameOffset * 4);
        k.received += c.frames;
        log.push(`chunk ${c.clipId}@${c.frameOffset}`);
      } else if (env.kind === Kind.CLIP_UNLOAD) {
        const u = readClipUnload(view, 0);
        log.push(`unload ${u.clipId}`);
        kernels.delete(u.clipId);
      } else throw new Error(`unexpected kind ${env.kind}`);
    },
  };
  return { port, kernels, log };
}
