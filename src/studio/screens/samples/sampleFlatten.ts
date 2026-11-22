// Flatten (ADR 0328): render the sample's baked chain with its automation and the normalize gain (`renderSample`; the
// render keeps the source's timeline, so trim, loops and markers still apply to it) into a new file beside its source,
// `<name>.flat<n>.wav`, and point the sample
// at it (`sample.source`) as one undoable step. Unflatten points it back at the source, also one step. The render file
// stays on disk either way (the original is never touched), so undo and redo only move the pointer.
//
// TODO(ADR 0328): render on a worker and cache by content hash in `.myco/cache/samples/` (the editor's Play and the
// export use that cache); today the Studio renders on its page when asked.
import { renderSample, type RenderedSample, type SamplePcm } from "../../../engine/audio/sample/sampleRender";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { encodeWavFloat32 } from "../../../engine/audio/sample/wavEncode";
import { docVersion } from "../../../editor/state";
import { nameOf } from "./sampleLibrary";
import type { SampleSession } from "./sampleSession";

/** A render's file name: `<stem>.flat<n>.wav`. */
const FLAT_NAME = /\.flat(\d+)\.wav$/i;

/** True for a flattened render's path. */
export const isFlatRender = (path: string): boolean => FLAT_NAME.test(path);

/** The first free `<stem>.flat<n>.wav` beside `source` among `files` (n counts up from 1, past any taken). */
export function flatPathFor(files: readonly string[], source: string): string {
  const slash = source.lastIndexOf("/");
  const folder = slash >= 0 ? source.slice(0, slash + 1) : "";
  const stem = nameOf(source).replace(/\.[^.]+$/, "").replace(/\.flat\d+$/i, "");
  const taken = new Set(files.map((f) => f.toLowerCase()));
  for (let n = 1; ; n++) {
    const path = `${folder}${stem}.flat${n}.wav`;
    if (!taken.has(path.toLowerCase())) return path;
  }
}

/** True when the edits hold something a render bakes: an enabled effect (reverse aside) or a normalize gain. */
export function hasRenderableEdits(e: SampleEdits): boolean {
  return e.effects.some((f) => f.on && f.type !== "reverse") || (e.normalize.mode !== "off" && e.normalize.gainDb !== 0);
}

/**
 * The audio file a flattened sample plays: `source` as a project path when the project has it, else a bare name in the
 * source file's folder (the runtime's rule); null when the sample isn't flattened.
 */
export function renderPathOf(files: readonly string[], audio: string, e: Pick<SampleEdits, "source">): string | null {
  if (e.source === undefined) return null;
  if (files.includes(e.source)) return e.source;
  const slash = audio.lastIndexOf("/");
  return `${slash >= 0 ? audio.slice(0, slash + 1) : ""}${e.source}`;
}

/** The edits without a render pointer. */
function withoutSource(e: SampleEdits): SampleEdits {
  const next = { ...e };
  delete next.source;
  return next;
}

export type FlattenResult = { readonly path: string; readonly render: RenderedSample } | { readonly refused: string };

/**
 * Flatten `session`'s sample: render its edits from `pcm` (its source audio, decoded), write the render beside the
 * source and set `sample.source` to it as the step "Flatten" (Re-flatten writes the next `flat<n>`).
 */
export async function flattenSample(session: SampleSession, pcm: SamplePcm): Promise<FlattenResult> {
  if (session.readOnly) return { refused: "the sample is read-only" };
  const edits = withoutSource(session.edits.peek());
  if (!hasRenderableEdits(edits)) return { refused: "nothing to flatten: the sample plays its source as it is" };
  const render = await renderSample(pcm, edits);
  const project = session.project;
  const path = flatPathFor(project.files, session.source.peek());
  await project.writeBinary(path, encodeWavFloat32(render.pcm, render.channels, render.rate));
  docVersion.value++;
  const flattened = session.edits.peek().source !== undefined;
  session.commit({ next: { ...session.edits.peek(), source: path }, label: flattened ? `Re-flatten · ${nameOf(path)}` : `Flatten · ${nameOf(path)}` });
  return { path, render };
}

/** Point the sample back at its source (the step "Unflatten"); false when it isn't flattened. */
export function unflattenSample(session: SampleSession): boolean {
  const e = session.edits.peek();
  if (e.source === undefined) return false;
  return session.commit({ next: withoutSource(e), label: "Unflatten" });
}
