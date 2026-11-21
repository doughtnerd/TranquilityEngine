// One open music node (ADR 0313): a segment, or a playlist or music switch, of an audio event, by id. The segment view,
// the segment panel and the rules table are views over it. It reads the node from the event's asset document, applies a
// refused-or-next edit of the node (ADR 0307) as one undo step of that document, a drag's steps merged into one, and
// answers clip facts and waveforms from the project's peaks service: a read of a clip not decoded yet starts its decode,
// and `version` is bumped when it arrives, so a view that read it renders again.
import { signal, type ReadonlySignal } from "@preact/signals";
import type { AssetDocument } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { findMusicContainer, findMusicSegment, replaceMusicNode } from "../../../../engine/audio/musicTree";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { applyEdit, placeEdit, refuse, type EditResult } from "../editResult";
import type { PeaksService } from "./peaks";
import type { PeakMips } from "./peaksMip";

/** What a handle opens: a segment, or a container (a playlist or a music switch). */
export type MusicNodeKind = "segment" | "container";
type NodeOf<K extends MusicNodeKind> = K extends "segment" ? SegmentNode : MusicContainerNode;

export interface MusicNodeHandle<N> {
  /** The event file's path (follows renames). */
  readonly path: string;
  readonly id: string;
  /** The event as its document holds it now. */
  readonly asset: AudioEventAsset;
  /** The node now, or null when the event has no node of the kind with this id. */
  readonly node: N | null;
  /** The project can't be saved to: edits are refused by the document. */
  readonly readOnly: boolean;
  /**
   * Apply an edit of the node: placed into the event and committed as one undo step labelled `label` (a drag passes
   * `coalesce`, merging its steps into one), or the refusal in the status bar. A missing node is refused. Returns whether
   * it was accepted.
   */
  apply(result: EditResult<N>, label: string, options?: { readonly coalesce?: boolean }): boolean;
  /** The clip's facts (frames, rate, channels) once decoded, else undefined (and its decode is started). */
  clip(path: string): MusicClipFacts | undefined;
  /** The clip's length in seconds once decoded, else undefined. */
  seconds(path: string): number | undefined;
  /** The clip's peak mips for drawing once decoded, else undefined. */
  waveform(path: string): PeakMips | undefined;
  /** Resolves once each clip is decoded or has failed to (an import waits on it before reading `clip`). */
  decoded(paths: readonly string[]): Promise<void>;
  /** Bumped when a clip's peaks arrive; the reads above read it, so a render that read a clip follows it. */
  readonly version: ReadonlySignal<number>;
  /** Write any pending (coalesced) edit now. */
  flush(): Promise<void>;
}

/** The handle of node `id` of kind `kind` in the event `document` holds, with clip facts from `peaks`. */
export function musicNodeHandle<K extends MusicNodeKind>(
  document: AssetDocument<AudioEventAsset>,
  peaks: Pick<PeaksService, "get" | "peek">,
  kind: K,
  id: string,
): MusicNodeHandle<NodeOf<K>> {
  const find = (asset: AudioEventAsset): NodeOf<K> | null =>
    (kind === "segment" ? findMusicSegment(asset.musicRoot, id) : findMusicContainer(asset.musicRoot, id)) as NodeOf<K> | null;
  const version = signal(0);
  const pending = new Set<string>();

  /** The clip's mips, starting its decode when it isn't known (one request at a time per clip). */
  const mips = (path: string): PeakMips | undefined => {
    void version.value;
    if (path === "") return undefined;
    const known = peaks.peek(path);
    if (known || pending.has(path)) return known;
    pending.add(path);
    peaks.get(path).then(
      () => {
        pending.delete(path);
        version.value++;
      },
      () => void pending.delete(path), // not decodable (yet): a later read asks again
    );
    return undefined;
  };

  return {
    get path() { return document.path; },
    id,
    get asset() { return document.value.value; },
    get node() { return find(document.value.value); },
    get readOnly() { return document.readOnly; },
    apply(result, label, options) {
      const asset = document.value.value;
      const node = find(asset);
      const placed = node === null
        ? refuse(`${document.path} has no ${kind === "segment" ? "segment" : "playlist or music switch"} "${id}"`)
        : placeEdit(result, node, asset, (next) => ({ ...asset, musicRoot: replaceMusicNode(asset.musicRoot!, id, next) }));
      return applyEdit(placed, label, (next) => document.edit(next, options?.coalesce ? { coalesce: true, label } : { label }), asset);
    },
    clip(path) {
      const m = mips(path);
      return m ? { frames: m.frames, rate: m.rate, channels: Math.min(2, Math.max(1, m.channels)), gapless: true } : undefined;
    },
    seconds(path) {
      const m = mips(path);
      return m && m.rate > 0 ? m.frames / m.rate : undefined;
    },
    waveform: mips,
    async decoded(paths) {
      await Promise.all(paths.map((p) => peaks.get(p).catch(() => undefined)));
      version.value++;
    },
    version,
    flush: () => document.flush(),
  };
}
