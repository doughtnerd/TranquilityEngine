// F-33: the real inputs of the transport service (see `transportService.ts`): the open segment, play mode, the project's
// files, and the panel's solo and mute. Started by `transportHost.ts` when the shared transport is made.
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import { playing } from "../../../../editor/state";
import { openSegment } from "./index";
import { audibleStems, auditionKey, auditionOf } from "./SegmentPanel";
import type { Transport } from "./transport";
import { startTransportService } from "./transportService";
import { findSegment } from "./segmentViewModel";

export function startMusicTransportService(transport: Transport): () => void {
  return startTransportService(transport, {
    open: openSegment,
    playMode: playing,
    files: () => { editor.project.version; return editor.project.current?.files ?? null; },
    audible: () => {
      const open = openSegment.value;
      const project = editor.project.current;
      if (!open || !project || !project.files.includes(open.event)) return undefined;
      const segment = findSegment(openAssetDocument<AudioEventAsset>(project, open.event, "audioEvent").value.value.musicRoot, open.segmentId);
      if (!segment) return undefined;
      const state = auditionOf(auditionKey(open.event, open.segmentId));
      const audible = state.solo.length > 0 || state.mute.length > 0 ? audibleStems(segment.tracks, state) : null;
      return { segmentId: open.segmentId, audible };
    },
  });
}
