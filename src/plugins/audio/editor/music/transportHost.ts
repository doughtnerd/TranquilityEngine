// The real audio host of the transport (Ed5): `Audio.play` on the editor's own World, the event document's flush, and P8's
// reload hook. One transport per editor; the segment view's panel owns its ticking.
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import { Audio } from "../../runtime/Audio";
import { auditionStems, startAtSegment } from "../../runtime/music/editorHooks";
import { noteAssetChanged } from "../../runtime/music/reload";
import { createTransport, type TransportHost } from "./transport";

export const realTransportHost: TransportHost = {
  play: (path, parameters) => Audio.play(path, { parameters }),
  flush: async (path) => {
    const project = editor.project.current;
    if (project) await openAssetDocument<AudioEventAsset>(project, path, "audioEvent").flush();
  },
  reload: (path) => noteAssetChanged(path),
  startAt: (handle, segmentId) => (handle.music ? startAtSegment(handle.music, segmentId) : false),
  stems: (handle, segmentId, audible) => void (handle.music ? auditionStems(handle.music, segmentId, audible) : false),
};

export const musicTransport = createTransport(realTransportHost);
