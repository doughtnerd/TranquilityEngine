// Flatten (ADR 0328): render the sample's baked chain with its automation and the normalize gain (`renderSample`; the
// render keeps the source's timeline, so trim, loops and markers still apply to it) into a new file beside its source,
// `<name>.flat<n>.wav`, and point the sample at it (`sample.source`) as one undoable step. Unflatten points it back at
// the source, also one step. The render file stays on disk either way (the original is never touched), so undo and
// redo only move the pointer.
//
// Renders run on the render worker and are cached by content hash in `.myco/cache/samples/` (`renderCache.ts`): a
// render of the same source bytes and the same baked edits is read back, not made again, so Re-flatten of unchanged
// edits is instant, and when the sample already plays that render nothing is written at all.
import { cachedRender, type RenderStore, type SampleRenderer } from "../../../engine/audio/sample/renderCache";
import { hasRenderableEdits, type SamplePcm } from "../../../engine/audio/sample/sampleRender";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { joinPath } from "../../../editor/projectPaths";
import { docVersion } from "../../../editor/state";
import { nameOf } from "./sampleLibrary";
import { projectRenderStore, renderInBackground } from "./sampleRenderClient";
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

export type FlattenResult =
  | {
      readonly path: string;
      /** True when the render came from the cache (nothing was rendered). */
      readonly hit: boolean;
      /** True when the sample already played this exact render: nothing was written and no step was made. */
      readonly unchanged: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly refused: string };

/** Where Flatten reads the source and how it renders (the screen's defaults: the project's cache, the render worker). */
export interface FlattenSource {
  /** The source audio file's bytes (the cache key is made of them). */
  readonly bytes: Uint8Array;
  /** The source decoded; only called when the cache has no render. */
  pcm(): Promise<SamplePcm>;
  readonly store?: RenderStore;
  readonly render?: SampleRenderer;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Flatten `session`'s sample: render its edits (or read the cached render), write it beside the source and set
 * `sample.source` to it as the step "Flatten" (Re-flatten writes the next `flat<n>`; when the sample already plays an
 * identical render, nothing changes).
 */
export async function flattenSample(session: SampleSession, source: FlattenSource): Promise<FlattenResult> {
  if (session.readOnly) return { refused: "the sample is read-only" };
  const edits = withoutSource(session.edits.peek());
  if (!hasRenderableEdits(edits)) return { refused: "nothing to flatten: the sample plays its source as it is" };
  const project = session.project;
  const out = await cachedRender(source.store ?? projectRenderStore(project), source.bytes, edits, source.pcm, source.render ?? renderInBackground);
  const current = renderPathOf(project.files, session.source.peek(), session.edits.peek());
  if (current && project.files.includes(current)) {
    const fs = project.fileSystem, root = project.root;
    const now = fs && root ? await fs.readBinary(joinPath(root, current)).catch(() => null) : null;
    if (now && sameBytes(now, out.bytes)) return { path: current, hit: out.hit, unchanged: true, warnings: out.warnings };
  }
  const path = flatPathFor(project.files, session.source.peek());
  await project.writeBinary(path, out.bytes);
  docVersion.value++;
  const flattened = session.edits.peek().source !== undefined;
  session.commit({ next: { ...session.edits.peek(), source: path }, label: flattened ? `Re-flatten · ${nameOf(path)}` : `Flatten · ${nameOf(path)}` });
  return { path, hit: out.hit, unchanged: false, warnings: out.warnings };
}

/** Point the sample back at its source (the step "Unflatten"); false when it isn't flattened. */
export function unflattenSample(session: SampleSession): boolean {
  const e = session.edits.peek();
  if (e.source === undefined) return false;
  return session.commit({ next: withoutSource(e), label: "Unflatten" });
}
