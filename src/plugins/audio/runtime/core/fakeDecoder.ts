// Test support: a stand-in for the decoder worker's client that "decodes" to planar f32 a test supplies, so registry and
// backend tests need no wasm. It answers like the worker does: interleaved int16 at the clip's own rate, one chunk.
import type { DecodeClipOptions, DecodedClip, DecoderClient, PrimeGroupOptions, StreamReply } from "../decoder/decoderClient";
import type { MusicReply } from "../decoder/protocol";

/** What a fake decode produces: planar f32, one array per channel, each `frames` long. */
export interface PlanarClip {
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly channelData: readonly Float32Array[];
}

/** f32 to int16 as the wire scales it: clamp to [-1, 1], `s < 0 ? s * 32768 : s * 32767`, round half away from zero, NaN to 0. */
export function interleaveI16(channels: readonly Float32Array[], start: number, frames: number, dst: Int16Array): void {
  const n = channels.length;
  for (let c = 0; c < n; c++) {
    const src = channels[c]!;
    for (let f = 0, d = c; f < frames; f++, d += n) {
      const v = src[start + f]!;
      if (Number.isNaN(v)) {
        dst[d] = 0;
        continue;
      }
      const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
      const s = clamped < 0 ? clamped * 32768 : clamped * 32767;
      dst[d] = Math.sign(s) * Math.round(Math.abs(s));
    }
  }
}

/** The members the fake holds open for one group: stream id to its asset, current epoch and start frame. */
export interface FakeGroupMember {
  readonly asset: string;
  readonly epoch: number;
  readonly startFrame: number;
}

/** What `fakeDecoder` returns: `decodeClip`, plus the music-group half of `DecoderClient` (ADR 0166 §4.6, C8), in process. */
export interface FakeDecoder extends Pick<DecoderClient, "decodeClip" | "primeGroup" | "cancelGroup" | "protectMusic" | "releaseMusic" | "invalidateMusic" | "onMusic" | "onStream"> {
  /** Every path passed to `invalidateMusic`, oldest first (for tests). */
  readonly invalidated: readonly string[];
  /** The groups open now (group id to its members by stream id); a cancelled group is gone (for tests). */
  openGroups(): ReadonlyMap<number, ReadonlyMap<number, FakeGroupMember>>;
  /** Every `primeGroup` the fake received, oldest first, without the bytes (for tests). */
  readonly primed: readonly Omit<PrimeGroupOptions, "members">[];
}

/**
 * A decoder client whose `decodeClip` calls `decode` with a copy of the encoded bytes and delivers the planar result as
 * the worker would (`onInfo` with the length known, one `onChunk`). `decode` may throw or reject to fail the clip.
 */
export function fakeDecoder(decode: (encoded: ArrayBuffer) => PlanarClip | Promise<PlanarClip>): FakeDecoder {
  const groups = new Map<number, Map<number, FakeGroupMember>>();
  const primed: Omit<PrimeGroupOptions, "members">[] = [];
  const streamListeners = new Set<(reply: StreamReply) => void>();
  const musicListeners = new Set<(reply: MusicReply) => void>();
  const invalidated: string[] = [];
  return {
    openGroups: () => groups,
    primed,
    invalidated,
    /**
     * L-D1ba: as the worker does (§4.6, C8). `retarget: false` opens each member (stream id, asset, epoch, start frame) and
     * emits `streamOpened` through `onStream`, then one `groupOpened` through `onMusic` (every member listed, no error).
     * `retarget: true` restarts members already open in the group at their new `startFrame` and `epoch` (an epoch not newer
     * than the member's is ignored) and opens the others, then one `groupOpened`. Records the message in `primed`.
     */
    primeGroup(options: PrimeGroupOptions): void {
      const { members, ...head } = options;
      primed.push(head);
      let open = groups.get(options.group);
      if (!open) {
        open = new Map<number, FakeGroupMember>();
        groups.set(options.group, open);
      }
      const target = open;
      for (const m of members) {
        const existing = target.get(m.streamId);
        if (options.retarget && existing) {
          // C8: a retargeted member restarts only under a newer epoch (wrap-safe); otherwise nothing changes.
          if (((m.epoch - existing.epoch) | 0) > 0) target.set(m.streamId, { asset: m.asset, epoch: m.epoch, startFrame: m.startFrame });
          continue;
        }
        target.set(m.streamId, { asset: m.asset, epoch: m.epoch, startFrame: m.startFrame });
        // The fake decodes nothing, so the stream's info is unknown until a real decode would report it.
        const info = { rate: 48_000, channels: 1, frames: -1, framesEstimate: -1, codec: 0, lengthKnown: false };
        for (const l of streamListeners) l({ type: "streamOpened", streamId: m.streamId, epoch: m.epoch, info });
      }
      const reply: MusicReply = {
        type: "groupOpened",
        group: options.group,
        members: members.map((m) => ({ streamId: m.streamId, openMs: 0 })),
      };
      for (const l of musicListeners) l(reply);
    },
    /** L-D1ba: emits `streamClosed` through `onStream` for each member of `group` and forgets the group; unknown ids are ignored. */
    cancelGroup(group: number): void {
      const open = groups.get(group);
      if (!open) return;
      const ids = [...open.keys()];
      groups.delete(group);
      for (const streamId of ids) for (const l of streamListeners) l({ type: "streamClosed", streamId });
    },
    /** L-D1ba: accepted and ignored (the fake has no encoded cache). */
    protectMusic(instance: number, paths: readonly string[]): void {
      void [instance, paths];
    },
    /** L-D1ba: accepted and ignored (the fake has no encoded cache). */
    releaseMusic(instance: number): void {
      void instance;
    },
    /** P8: recorded. */
    invalidateMusic(path: string): void {
      invalidated.push(path);
    },
    onMusic(listener: (reply: MusicReply) => void): () => void {
      musicListeners.add(listener);
      return () => musicListeners.delete(listener);
    },
    onStream(listener: (reply: StreamReply) => void): () => void {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    async decodeClip(bytes: ArrayBuffer | Uint8Array, _hint?: number, options?: DecodeClipOptions): Promise<DecodedClip> {
      const copy = bytes instanceof ArrayBuffer ? bytes.slice(0) : (bytes.slice().buffer as ArrayBuffer);
      const clip = await decode(copy);
      const pcm = new Int16Array(clip.frames * clip.channels);
      interleaveI16(clip.channelData, 0, clip.frames, pcm);
      const info = { rate: clip.sampleRate, channels: clip.channels, frames: clip.frames, framesEstimate: clip.frames, codec: 1, lengthKnown: true };
      options?.onInfo?.(info);
      if (pcm.length > 0) options?.onChunk?.(pcm, 0);
      return { pcm: options?.collect === false ? new Int16Array(0) : pcm, rate: clip.sampleRate, channels: clip.channels, frames: clip.frames, info };
    },
  };
}
