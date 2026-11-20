// The editor's one audition (ADR 0268) on the real audio host: `Audio.play` on the editor's own World (it has the view, so
// `Audio.play` works outside play mode too), the event document's flush (a write replaces the raw asset object the
// runtime's parse cache is keyed on, so flushing before Play is all "reload" takes), P8's reload and start hooks, and
// `Audio.debug()` for the instance's rows. The lifetime service starts with it and reads the open segment, play mode, the
// project's files and the segment panel's solo and mute.
import { computed } from "@preact/signals";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { findMusicSegment } from "../../../../engine/audio/musicTree";
import { Assets } from "../../../../engine/scene/Assets";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import { Audio } from "../../runtime/Audio";
import { auditionStems, startAtPosition, startAtSegment } from "../../runtime/music/editorHooks";
import { noteAssetChanged } from "../../runtime/music/reload";
import { openSegment } from "../music/index";
import { audibleStems, auditionKey, auditionOf } from "../music/stemAudition";
import { createAudition, type AuditionHost } from "./audition";
import { startAuditionService } from "./auditionService";

const realAuditionHost: AuditionHost = {
  play: (path, parameters) => Audio.play(path, { parameters }),
  flush: async (path) => {
    const project = editor.project.current;
    if (project) await openAssetDocument<AudioEventAsset>(project, path, "audioEvent").flush();
  },
  reload: (path) => noteAssetChanged(path),
  startAt: (handle, segmentId) => (handle.music ? startAtSegment(handle.music, segmentId) : false),
  startAtPosition: (handle, position) => (handle.music ? startAtPosition(handle.music, position) : false),
  stems: (handle, segmentId, audible) => void (handle.music ? auditionStems(handle.music, segmentId, audible) : false),
  inspect: () => {
    const info = Audio.debug();
    return { status: Audio.status, backend: info.core.backend, events: info.events, voices: info.voices };
  },
  asset: (path) => {
    try { return Assets.json<object>(path); } catch { return undefined; }
  },
};

export const editorAudition = createAudition(realAuditionHost);

startAuditionService(editorAudition, {
  open: openSegment,
  // Play mode through the SDK (ADR 0147: plugins never import the shell's state): truthy while not editing.
  playMode: computed(() => (editor.scene.playState === "edit" ? null : editor.scene.playState)),
  files: () => { editor.project.version; return editor.project.current?.files ?? null; },
  audible: () => {
    const open = openSegment.value;
    const project = editor.project.current;
    if (!open || !project || !project.files.includes(open.event)) return undefined;
    const segment = findMusicSegment(openAssetDocument<AudioEventAsset>(project, open.event, "audioEvent").value.value.musicRoot, open.segmentId);
    if (!segment) return undefined;
    const state = auditionOf(auditionKey(open.event, open.segmentId));
    const audible = state.solo.length > 0 || state.mute.length > 0 ? audibleStems(segment.tracks, state) : null;
    return { segmentId: open.segmentId, audible };
  },
});
