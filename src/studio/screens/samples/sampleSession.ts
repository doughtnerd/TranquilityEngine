// An open sample on the Samples screen (ADR 0328): its edits live in an asset document (the engine's undo tree and
// persistent history, ADR 0027/0133), either of the audio file's sidecar (`<file>.meta.json`, the `sample` block) or of
// a derived sample (`*.sample.json`). Each edit is one labelled step; drags coalesce. Also the sample's audio as the
// screen reads it: peaks (on the shared decoder worker), decoded PCM for the loudness measure, the loop seam and zero
// crossings, and the WAV's chunks for the file diff, merge and Write to file.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { deepEqual } from "../../../engine/audio/deepEqual";
import { audioSection } from "../../../engine/audio/audioSection";
import { measureLoudness, type LoudnessMeasure } from "../../../engine/audio/loudness/integrated";
import { defaultSampleEdits, derivedSampleToJson, parseDerivedSample, resolveSampleEdits, sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { SAMPLE_FORMAT, type DerivedSampleAsset, type SampleEdits } from "../../../engine/audio/sample/types";
import { readWavMetadata, type WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { defaultImportSettings, formatImportSettings, parseImportSettings, sidecarPath, type ImportSettings } from "../../../engine/scene/importSettings";
import { openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { assetKinds } from "../../../editor/sdk/contributions";
import type { EditorProject } from "../../../editor/projects";
import { status } from "../../../editor/state";
import { peaksFor } from "../../../plugins/audio/editor/music/peaksHost";
import type { PeakMips } from "../../../plugins/audio/editor/music/peaksMip";
import { sharedDecoderClient } from "../../../plugins/audio/runtime/decoder/decoderClient";
import { hintFromName } from "../../../plugins/audio/runtime/decoder/protocol";
import type { SampleEdit } from "./sampleEditing";
import type { Pcm } from "./seam";

/** The sidecar document kind (no file ending: opened by id, so the editor's classification of `.meta.json` is unchanged). */
export const SIDECAR_KIND = "studio.sampleSidecar";
/** Derived samples use the audio plugin's own `derivedSample` kind (ADR 0328), which the Studio activates. */
export const DERIVED_KIND = "derivedSample";

let registered = false;
/** Register the sidecar document format (once per page). */
export function registerSampleKinds(): void {
  if (registered) return;
  registered = true;
  assetKinds.register({
    id: SIDECAR_KIND, extensions: [], label: "Sample settings", icon: "M4 12h16",
    format: {
      parse: (raw, path) => {
        const { settings, problems } = parseImportSettings(raw, path);
        return { value: settings, problems: problems.map((message) => ({ message })) };
      },
      format: formatImportSettings,
      empty: defaultImportSettings,
      writeDelay: 300,
    },
  });
}

export const isDerived = (path: string): boolean => path.toLowerCase().endsWith(".sample.json");

export interface SampleSession {
  readonly project: EditorProject;
  /** The sample: an audio file or a `*.sample.json`. */
  readonly path: string;
  /** The document holding the edits (the sidecar, or the derived sample); its path marks the editor (`data-asset-document`). */
  readonly documentPath: string;
  /** The audio file it plays. */
  readonly source: ReadonlySignal<string>;
  /** The edits as they play (a following fork's inherited fields resolved). */
  readonly edits: ReadonlySignal<SampleEdits>;
  readonly derived: ReadonlySignal<DerivedSampleAsset | null>;
  /** The sidecar's other settings (Load = `stream`), for an audio file. */
  readonly settings: ReadonlySignal<ImportSettings | null>;
  readonly readOnly: boolean;
  /** Apply an edit as one step (a refusal goes to the status bar). `coalesce` merges a drag into one step. */
  commit(result: SampleEdit, options?: { coalesce?: boolean }): boolean;
  /** Replace a derived sample's whole file as one step (Update from parent re-pins it). No-op for an audio file. */
  editDerived(next: DerivedSampleAsset, label: string): void;
  /** Undo the document's last step (a toast's Undo). */
  undo(): void;
  /** Replace the sidecar's settings around the block (Load). */
  setSettings(next: ImportSettings, label: string): void;
}

const sessions = new WeakMap<EditorProject, Map<string, SampleSession>>();

function sidecarSession(project: EditorProject, path: string): SampleSession {
  const doc = openAssetDocument<ImportSettings>(project, sidecarPath(path), SIDECAR_KIND);
  const edits = computed(() => sampleEditsFromSidecar(doc.value.value));
  const commit = (result: SampleEdit, options?: { coalesce?: boolean }) => {
    if ("refused" in result) {
      status.value = { kind: "info", text: `Can't do that: ${result.refused}.` };
      return false;
    }
    // Writing the block also stops the legacy loop fields from shadowing it (the Studio writes only `loops`).
    doc.edit({ ...doc.value.peek(), sample: result.next, loopStart: null, loopEnd: null }, { label: result.label, coalesce: options?.coalesce });
    return true;
  };
  return {
    project, path, documentPath: doc.path, source: signal(path), edits, derived: signal(null), settings: doc.value, readOnly: doc.readOnly, commit,
    setSettings: (next, label) => doc.edit(next, { label }),
    editDerived: () => undefined,
    undo: () => doc.undo(),
  };
}

/** A derived sample's edits: a following fork stores only what it changed against its baseline (`resolveSampleEdits`). */
function derivedSession(project: EditorProject, path: string): SampleSession {
  const doc: AssetDocument<DerivedSampleAsset> = openAssetDocument<DerivedSampleAsset>(project, path, DERIVED_KIND);
  const parentEdits = (d: DerivedSampleAsset): SampleEdits => {
    const parent = d.lineage.parent;
    if (!parent || parent === path) return d.sample;
    if (isDerived(parent)) return readAsset<DerivedSampleAsset>(project, parent, DERIVED_KIND).value.sample;
    return sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(parent), SIDECAR_KIND).value);
  };
  const edits = computed(() => resolveSampleEdits(doc.value.value, parentEdits(doc.value.value)));
  const commit = (result: SampleEdit, options?: { coalesce?: boolean }) => {
    if ("refused" in result) {
      status.value = { kind: "info", text: `Can't do that: ${result.refused}.` };
      return false;
    }
    const d = doc.value.peek();
    const before = edits.peek();
    // Fields the edit didn't touch keep the fork's own value, so an inherited field stays inherited.
    const sample = { ...d.sample } as Record<string, unknown>;
    for (const [k, v] of Object.entries(result.next)) if (!deepEqual(v, (before as unknown as Record<string, unknown>)[k])) sample[k] = v;
    // A field the edit removed (Unflatten's `source`) goes from the fork's own fields too.
    for (const k of Object.keys(before)) if (!(k in result.next)) delete sample[k];
    doc.edit({ ...d, sample: sample as unknown as SampleEdits }, { label: result.label, coalesce: options?.coalesce });
    return true;
  };
  return {
    project, path, documentPath: doc.path, source: computed(() => doc.value.value.source), edits, derived: doc.value, settings: signal(null), readOnly: doc.readOnly, commit,
    setSettings: () => undefined,
    editDerived: (next, label) => doc.edit(next, { label }),
    undo: () => doc.undo(),
  };
}

/** The session for `path` in `project` (one per path; follows the document). */
export function sampleSession(project: EditorProject, path: string): SampleSession {
  registerSampleKinds();
  let byPath = sessions.get(project);
  if (!byPath) sessions.set(project, (byPath = new Map()));
  let s = byPath.get(path);
  if (!s) byPath.set(path, (s = isDerived(path) ? derivedSession(project, path) : sidecarSession(project, path)));
  return s;
}

/** Drop a session (its file moved or was deleted). */
export function forgetSession(project: EditorProject, path: string): void {
  sessions.get(project)?.delete(path);
}

// --- the audio --------------------------------------------------------------------------------------------------------

type Load<T> = { readonly state: "ready"; readonly value: T } | { readonly state: "failed"; readonly reason: string };

/** What the screen has read of each audio file, by its asset URL (a new URL is a new version of the file). */
const peaks = signal<ReadonlyMap<string, Load<PeakMips>>>(new Map());
const pcms = new Map<string, Promise<Pcm>>();
const loudness = signal<ReadonlyMap<string, Load<LoudnessMeasure>>>(new Map());
const metadata = signal<ReadonlyMap<string, Load<WavMetadata>>>(new Map());
const pcmReady = signal<ReadonlyMap<string, Pcm>>(new Map());

const urlOf = (project: EditorProject, path: string): string | null => {
  const url = project.assets.get(path);
  return typeof url === "string" ? url : null;
};

const setIn = <T>(s: { value: ReadonlyMap<string, T> }, key: string, value: T) => {
  const next = new Map(s.value);
  next.set(key, value);
  s.value = next;
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Reads started, by kind and URL: a read starts once, and nothing is written to a signal while a view draws. */
const started = new Set<string>();
const startOnce = (key: string, run: () => void): void => {
  if (started.has(key)) return;
  started.add(key);
  run();
};

/** The file's peaks (null while they load or when they failed); starts reading them the first time. */
export function peaksOf(project: EditorProject, path: string): PeakMips | null {
  const url = urlOf(project, path);
  if (!url) return null;
  const known = peaks.value.get(url);
  if (!known) {
    startOnce(`peaks ${url}`, () =>
      void peaksFor(project)
        .get(path)
        .then((value) => setIn(peaks, url, { state: "ready", value }))
        .catch((err) => setIn(peaks, url, { state: "failed", reason: why(err) })),
    );
    return null;
  }
  return known.state === "ready" ? known.value : null;
}

/** Why the peaks failed, if they did. */
export function peaksFailure(project: EditorProject, path: string): string | null {
  const url = urlOf(project, path);
  const known = url ? peaks.value.get(url) : undefined;
  return known?.state === "failed" ? known.reason : null;
}

/** The file's length in seconds once its peaks are read. */
export function lengthOf(project: EditorProject, path: string): number | null {
  const m = peaksOf(project, path);
  return m && m.rate > 0 ? m.frames / m.rate : null;
}

/** The file's bytes. */
export async function bytesOf(project: EditorProject, path: string): Promise<Uint8Array> {
  const url = urlOf(project, path);
  if (!url) throw new Error(`${path} is not an audio file in the project`);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** Audio bytes (named `path`, for the format hint) decoded on the decoder worker of the project's codecs. */
export async function decodeAudio(project: EditorProject, bytes: Uint8Array, path: string): Promise<Pcm> {
  const aac = audioSection((project.settings as { audio?: unknown }).audio).settings.codecs.aac;
  const clip = await sharedDecoderClient(aac ? "aac" : "default").decodeClip(bytes, hintFromName(path));
  return { pcm: clip.pcm, channels: clip.channels, rate: clip.rate };
}

/** The file decoded (cached per version) on the decoder worker of the project's codecs. */
export function pcmOf(project: EditorProject, path: string): Promise<Pcm> {
  const url = urlOf(project, path);
  if (!url) return Promise.reject(new Error(`${path} is not an audio file in the project`));
  let p = pcms.get(url);
  if (!p) {
    p = bytesOf(project, path).then((bytes) => decodeAudio(project, bytes, path));
    p.then((v) => setIn(pcmReady, url, v)).catch(() => pcms.delete(url));
    pcms.set(url, p);
  }
  return p;
}

/** The decoded PCM if it's ready (null while decoding; starts decoding the first time). For snapping and the seam. */
export function pcmNow(project: EditorProject, path: string): Pcm | null {
  const url = urlOf(project, path);
  if (!url) return null;
  const ready = pcmReady.value.get(url);
  if (ready) return ready;
  pcmOf(project, path).catch(() => undefined);
  return null;
}

/**
 * The measured loudness (integrated LUFS, sample peak), null until measured; starts measuring the first time.
 * TODO(ADR 0328): cache the measure in `.myco/cache/` across sessions, and measure on a worker for long files.
 */
export function loudnessOf(project: EditorProject, path: string): LoudnessMeasure | null {
  const url = urlOf(project, path);
  if (!url) return null;
  const known = loudness.value.get(url);
  if (!known) {
    startOnce(`loudness ${url}`, () =>
      void pcmOf(project, path)
        .then((pcm) => setIn(loudness, url, { state: "ready", value: measureLoudness(pcm) }))
        .catch((err) => setIn(loudness, url, { state: "failed", reason: why(err) })),
    );
    return null;
  }
  return known.state === "ready" ? known.value : null;
}

/** The WAV's chunks as they are on disk now (null while reading, or for a file that isn't a WAV). */
export function wavMetadataOf(project: EditorProject, path: string): WavMetadata | null {
  const url = urlOf(project, path);
  if (!url || !/\.wave?$/i.test(path)) return null;
  const known = metadata.value.get(url);
  if (!known) {
    startOnce(`metadata ${url}`, () =>
      void bytesOf(project, path)
        .then((bytes) => setIn(metadata, url, { state: "ready", value: readWavMetadata(bytes) }))
        .catch((err) => setIn(metadata, url, { state: "failed", reason: why(err) })),
    );
    return null;
  }
  return known.state === "ready" ? known.value : null;
}

/** Forget what was read of a file (after Write to file or a re-import replaced it). */
export function forgetAudio(project: EditorProject, path: string): void {
  const url = urlOf(project, path);
  if (!url) return;
  for (const s of [peaks, loudness, metadata, pcmReady] as { value: ReadonlyMap<string, unknown> }[]) {
    const next = new Map(s.value);
    next.delete(url);
    s.value = next;
  }
  pcms.delete(url);
  for (const k of [...started]) if (k.endsWith(` ${url}`)) started.delete(k);
  peaksFor(project).invalidate(path);
}
