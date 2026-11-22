// The Audio Studio's asset kinds in the editor (ADR 0329, 0328, 0333): playlists (`*.playlist.json`), derived samples
// (`*.sample.json`) and attenuation presets (`*.attenuation.json`). Each has its format (so the editor reads and writes
// it through asset documents, ADR 0233) and, where its files name others, its `references` reader (ADR 0148). No panel:
// the Studio edits them; the editor lists, moves and deletes them.
//
// Moves: these are JSON files, so a move rewrites the paths in them through their owner, like every JSON file's
// reference strings (ADR 0302, 0314 "JSON files stay with their owners"), and the readers below decide what a file
// depends on and is used by. Parsers and reference lists are the engine's.
import type { AssetFormat, AssetKindContribution, AssetReferences, EditorPluginContext } from "../../../editor/sdk";
import { ATTENUATION_FORMAT, ATTENUATION_SUFFIX, type AttenuationAsset } from "../../../engine/audio/attenuation/types";
import { attenuationAssetToJson, defaultAttenuation, parseAttenuationAsset } from "../../../engine/audio/attenuation/format";
import { emptyPlaylist, formatPlaylist, parsePlaylist } from "../../../engine/audio/playlist/format";
import { referencedPaths } from "../../../engine/audio/playlist/references";
import { PLAYLIST_SUFFIX, type PlaylistAsset } from "../../../engine/audio/playlist/types";
import { derivedSampleToJson, parseDerivedSample } from "../../../engine/audio/sample/format";
import { SAMPLE_SUFFIX, type DerivedSampleAsset } from "../../../engine/audio/sample/types";

/** A speaker beside a list: a playlist plays its entries. Drawn like the audio event's speaker. */
const PLAYLIST_ICON = "M3 9v6h3l4 4V5L6 9zM14 8h7M14 12h7M14 16h7";
/** A waveform: a sample is (part of) an audio file with its edits. */
const SAMPLE_ICON = "M2 12h3l2-5 3 10 3-14 3 14 2-7 2 2h2";
/** A level falling with distance over an axis. */
const ATTENUATION_ICON = "M4 4v16h16M4 6c4 0 6 3 8 7s4 5 8 5";

const toProblems = (problems: readonly string[]) => problems.map((message) => ({ message }));

/** JSON text's parsed value, or undefined when it isn't JSON (a reader then names nothing). */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The playlist format (ADR 0329): `parsePlaylist`, `formatPlaylist`; a new playlist is an empty Queue. */
export const playlistFormat: AssetFormat<PlaylistAsset> = {
  parse: (raw, path) => {
    const read = parsePlaylist(raw, path);
    return { value: read.playlist, problems: toProblems(read.problems) };
  },
  format: formatPlaylist,
  empty: () => emptyPlaylist("queue"),
};

/** What a playlist names (`playlistReferences`): linked playlists, samples and attenuation presets, embedded ones too. */
export const playlistReferenceReader: AssetReferences = {
  extensions: [PLAYLIST_SUFFIX],
  read: (_path, text) => {
    const raw = json(text);
    return raw === undefined ? [] : referencedPaths(parsePlaylist(raw).playlist);
  },
};

/** The derived sample format (ADR 0328): `parseDerivedSample`, `derivedSampleToJson`. A new one names no source. */
export const derivedSampleFormat: AssetFormat<DerivedSampleAsset> = {
  parse: (raw, path) => {
    const read = parseDerivedSample(raw, path);
    return { value: read.sample, problems: toProblems(read.problems) };
  },
  format: (value) => `${JSON.stringify(derivedSampleToJson(value), null, 2)}\n`,
  empty: () => parseDerivedSample({ format: "myco.sample@1" }).sample,
};

/** What a derived sample names: the audio file it plays and the sample it was made from. */
export const derivedSampleReferenceReader: AssetReferences = {
  extensions: [SAMPLE_SUFFIX],
  read: (_path, text) => {
    const raw = json(text);
    if (raw === undefined) return [];
    const { source, lineage } = parseDerivedSample(raw).sample;
    return [...new Set([source, lineage.parent].filter((p) => p !== ""))];
  },
};

/** The attenuation preset format (ADR 0333): `parseAttenuationAsset`, `attenuationAssetToJson`. */
export const attenuationFormat: AssetFormat<AttenuationAsset> = {
  parse: (raw, path) => {
    const read = parseAttenuationAsset(raw, path);
    return { value: read.attenuation, problems: toProblems(read.problems) };
  },
  format: (value) => `${JSON.stringify(attenuationAssetToJson(value), null, 2)}\n`,
  empty: () => ({ format: ATTENUATION_FORMAT, ...defaultAttenuation() }),
};

/** The three kinds, as registered. */
export const STUDIO_ASSET_KINDS: readonly AssetKindContribution[] = [
  {
    id: "playlist",
    extensions: [PLAYLIST_SUFFIX],
    label: "Playlist",
    icon: PLAYLIST_ICON,
    format: playlistFormat,
    folder: "audio",
    // `AudioSource.clip` takes a playlist where it took an audio event (ADR 0329 "Public API").
    referencedAs: ["audioEvent"],
    references: playlistReferenceReader,
  },
  { id: "derivedSample", extensions: [SAMPLE_SUFFIX], label: "Sample", icon: SAMPLE_ICON, format: derivedSampleFormat, folder: "audio", references: derivedSampleReferenceReader },
  { id: "attenuation", extensions: [ATTENUATION_SUFFIX], label: "Attenuation", icon: ATTENUATION_ICON, format: attenuationFormat, folder: "audio" },
];

/** Register the Studio's asset kinds (the audio plugin's `activate` calls it). */
export function registerStudioAssetKinds(context: Pick<EditorPluginContext, "registerAssetKind">): void {
  for (const kind of STUDIO_ASSET_KINDS) context.registerAssetKind(kind);
}
