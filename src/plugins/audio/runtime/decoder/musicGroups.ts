// The decoder worker's music groups (ADR 0166 §4.6, contract C8; architecture §2.2, §2.3, §4.2): `handler.ts` routes
// `primeGroup`, `cancelGroup`, `protectMusic` and `releaseMusic` here.
//
// Owners (M4 waves plan, H3): **D1a** wrote this file, the open path and the prime; **D1b** (W3) wrote `cancel` and the
// re-target (`open` with `retarget: true`); **D1c** fills `musicCache.ts`, which the open path reaches only through
// `lookup`, `hold` and `release` (D1c doesn't edit this file).
//
// The open path (`primeGroup` with `retarget: false`, `open` below):
// 1. `protect` and `budgetBytes`, when present, go to the cache first (so a hold below sees them).
// 2. Each member's bytes are the message's (`bytes`, transferred) or the cache's (`lookup`). A member with neither is
//    **not opened**: the worker answers one `needBytes` naming them, and main resends a `primeGroup` (`retarget: false`)
//    carrying only those members, with `bytes` (Q0's miss rule). The worker never fetches.
// 3. Every other member is opened as a music stream (`StreamDecoder.openMember`: STREAM_OPEN with the music flag, held,
//    `streamOpened` to main) and, once open, held in the cache (`hold`, with the bytes when main sent them).
// 4. `StreamDecoder.prime` over the opened members: breadth-first (every member's first 4,096 frames before any member
//    gets more), then round-robin top-ups.
// 5. One `groupOpened` (diagnostics only, never the primed signal: that is STATUS `musicRings`, R7): each member opened
//    or failed, with `openMs` from the message's arrival to its prime frames posted (or to its failure).
//
// A member stream that closes (D1b's cancel, or main's `streamClose` when the voice ended, `StreamHost.closed`) leaves
// its group and releases its cache reference (`release`). A group with no members left is forgotten.
import type { CancelGroupMessage, DecoderReply, MusicRequest, PrimeGroupMember, PrimeGroupMessage } from "./protocol";
import type { MusicCache } from "./musicCache";
import type { StreamDecoder } from "./streams";

export interface MusicGroupsHost {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  readonly streams: StreamDecoder;
  readonly cache: MusicCache;
  /** Milliseconds, for `openMs` (default `performance.now`). */
  now?(): number;
}

/** A member the worker opened: its asset (the cache's path) and epoch. */
interface Member {
  readonly asset: string;
  epoch: number;
}

/** A group: its instance and the member streams open on it, by stream id. */
interface Group {
  readonly instance: number;
  readonly members: Map<number, Member>;
  /** Set by `cancel`: an open still waiting on a member (the worker doesn't serialize requests) closes it and stops. */
  cancelled: boolean;
}

/** The worker's music groups (see the header). One per worker, beside the `StreamDecoder` it opens streams on. */
export class MusicGroups {
  private readonly groups = new Map<number, Group>();
  /** Stream id to its group id, for `closed`. */
  private readonly byStream = new Map<number, number>();

  constructor(private readonly host: MusicGroupsHost) {}

  /** Handles one music request; resolves when it has been dealt with (after the prime and `groupOpened`). */
  async handle(request: MusicRequest): Promise<void> {
    switch (request.type) {
      case "primeGroup":
        if (request.budgetBytes !== undefined) this.host.cache.setBudget(request.budgetBytes);
        if (request.protect) this.host.cache.protect(request.instance, request.protect);
        return this.open(request);
      case "cancelGroup":
        return this.cancel(request);
      case "protectMusic":
        this.host.cache.protect(request.instance, request.paths);
        return;
      case "releaseMusic":
        this.host.cache.releaseInstance(request.instance);
        return;
      case "invalidateMusic":
        this.host.cache.invalidatePath(request.path);
        return;
    }
  }

  /** Live groups (for tests). */
  get groupCount(): number {
    return this.groups.size;
  }

  /** The stream ids open in `group`, in open order (for tests and D1b). */
  membersOf(group: number): number[] {
    return [...(this.groups.get(group)?.members.keys() ?? [])];
  }

  /** `StreamHost.closed`: stream `streamId` closed; if it was a member, it leaves its group and releases its cache reference. */
  closed(streamId: number): void {
    const id = this.byStream.get(streamId);
    if (id === undefined) return;
    this.byStream.delete(streamId);
    const g = this.groups.get(id);
    const m = g?.members.get(streamId);
    if (!g || !m) return;
    g.members.delete(streamId);
    this.host.cache.release(g.instance, m.asset);
    if (g.members.size === 0) this.groups.delete(id);
  }

  /**
   * The open path (header, steps 2–5) and, with `retarget` (§4.6, C8), the re-target: a member already open in the group
   * restarts at its new `startFrame` under its new `epoch` (`StreamDecoder.restartMember`: the new STREAM_OPEN goes now,
   * held; an epoch not newer than the member's is ignored and reported as an error), a member not open yet takes the open
   * path; then one `prime` over every restarted and opened member in message order (so the breadth-first order of the
   * open holds), and one `groupOpened`. Without `retarget`, a member already open under its id is replaced as before.
   */
  private async open(m: PrimeGroupMessage): Promise<void> {
    const now = this.host.now ?? (() => performance.now());
    const t0 = now();
    const { cache, streams } = this.host;
    const existing = m.retarget ? this.groups.get(m.group) : undefined;
    const missing: { streamId: number; asset: string }[] = [];
    const ready: { member: PrimeGroupMember; bytes?: ArrayBuffer }[] = [];
    for (const member of m.members) {
      if (existing?.members.has(member.streamId)) {
        ready.push({ member });
        continue;
      }
      const bytes = member.bytes ?? cache.lookup(m.instance, member.asset);
      if (bytes) ready.push({ member, bytes });
      else missing.push({ streamId: member.streamId, asset: member.asset });
    }
    if (missing.length > 0) this.host.post({ type: "needBytes", group: m.group, members: missing });
    if (ready.length === 0) return;

    let g = this.groups.get(m.group);
    if (!g) this.groups.set(m.group, (g = { instance: m.instance, members: new Map(), cancelled: false }));
    const results = new Map<number, { openMs: number; error?: string }>();
    const toPrime = new Set<number>();
    // Restart the open members first: their STREAM_OPEN goes now, their chunks with the prime.
    for (const { member, bytes } of ready) {
      if (bytes) continue;
      const open = g.members.get(member.streamId);
      const ok =
        open !== undefined &&
        streams.restartMember(member.streamId, member.startFrame, member.epoch, {
          looping: member.loop,
          ...(member.loopStartFrame !== undefined ? { loopStartFrame: member.loopStartFrame } : {}),
          ...(member.loopEndFrame !== undefined ? { loopEndFrame: member.loopEndFrame } : {}),
        });
      if (ok) {
        open.epoch = member.epoch;
        toPrime.add(member.streamId);
      } else results.set(member.streamId, { openMs: now() - t0, error: "not restarted: stream not open or epoch not newer" });
    }
    for (const { member, bytes } of ready) {
      if (!bytes) continue;
      const r = await streams.openMember({
        type: "streamOpen",
        streamId: member.streamId,
        asset: member.asset,
        bytes,
        hint: member.hint,
        startFrame: member.startFrame,
        epoch: member.epoch,
        loop: member.loop,
        ...(member.loopStartFrame !== undefined ? { loopStartFrame: member.loopStartFrame } : {}),
        ...(member.loopEndFrame !== undefined ? { loopEndFrame: member.loopEndFrame } : {}),
        ...(member.convention ? { convention: member.convention } : {}),
      });
      if (g.cancelled) {
        // `cancel` ran while this member was opening: it isn't in the group yet, so close it here, and stop.
        if (r === true) streams.closeMember(member.streamId);
        for (const id of toPrime) if (g.members.has(id)) streams.closeMember(id);
        return;
      }
      if (r !== true) {
        results.set(member.streamId, { openMs: now() - t0, error: r });
        continue;
      }
      // A member re-sent under the same stream id replaced the old stream (`openStream` drops it): release the old hold.
      if (this.byStream.has(member.streamId)) this.closed(member.streamId);
      cache.hold(m.instance, member.asset, member.bytes);
      g.members.set(member.streamId, { asset: member.asset, epoch: member.epoch });
      this.byStream.set(member.streamId, m.group);
      if (!this.groups.has(m.group)) this.groups.set(m.group, g); // `closed` above may have emptied and dropped it
      toPrime.add(member.streamId);
    }
    const order = ready.map(({ member }) => member.streamId).filter((id) => toPrime.has(id));
    streams.prime(order, (id) => results.set(id, { openMs: now() - t0 }));
    // A member that opened but failed during its prime reported its error itself; it is still listed here, without openMs' meaning.
    for (const id of order) if (!results.has(id)) results.set(id, { openMs: now() - t0, error: "failed while priming" });
    if (g.cancelled) return;
    this.host.post({
      type: "groupOpened",
      group: m.group,
      members: ready.map(({ member }) => ({ streamId: member.streamId, ...results.get(member.streamId)! })),
    });
  }

  /**
   * `cancelGroup` (§4.6): closes every member stream the group opened (`StreamDecoder.closeMember`: STREAM_CLOSE to the
   * worklet, `streamClosed` to main; `closed` then releases each cache reference), and forgets the group, so its rings
   * and decoder memory are freed. An open still in flight for the group stops at its next member. Unknown ids are ignored.
   */
  private async cancel(m: CancelGroupMessage): Promise<void> {
    const g = this.groups.get(m.group);
    if (!g) return;
    g.cancelled = true;
    for (const id of [...g.members.keys()]) this.host.streams.closeMember(id);
    this.groups.delete(m.group);
  }
}
