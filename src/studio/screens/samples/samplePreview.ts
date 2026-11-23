// What the Samples timeline shows of the baked effects (spec §4.1.6 "the waveform reflects baked effects, normalize and
// gain"; §4.1.7's render chip): the sample rendered with its chain (or the chain up to the effect a row or chip is
// focused on, "the waveform after this step"), through the project's render cache (`.myco/cache/samples/`, ADR 0342),
// decoded once and turned into peaks for the waveform and PCM for the spectrogram. Renders start a moment after the
// edits settle, one at a time; the newest wanted render wins. A/B shows the source and renders nothing.
import { signal } from "@preact/signals";
import { cachedRender, renderInputs } from "../../../engine/audio/sample/renderCache";
import { hasRenderableEdits } from "../../../engine/audio/sample/sampleRender";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import type { PeakMips } from "../../components/waveformModel";
import { peaksOfPcm, type PcmFrames } from "./samplePeaks";
import { projectRenderStore, renderInBackground } from "./sampleRenderClient";
import { bytesOf, decodeAudio, pcmOf, type SampleSession } from "./sampleSession";

/** The render chip (spec §4.1.7): Source only / Rebuilding… / Cached / Frozen. */
export type RenderState = "source" | "rebuilding" | "cached" | "frozen";

export interface Preview {
  readonly state: RenderState;
  /** The render's peaks and PCM once made (null: show the source). */
  readonly mips: PeakMips | null;
  readonly pcm: PcmFrames | null;
  /** The cache key's first digits and the render's size, for the chip's tooltip. */
  readonly key: string | null;
  readonly bytes: number;
}

/** The edits a preview renders: the chain up to and including `focus` (an effect id), or the whole chain. */
export function editsUpTo(e: SampleEdits, focus: string | null): SampleEdits {
  const i = focus ? e.effects.findIndex((f) => f.id === focus) : -1;
  return i < 0 ? e : { ...e, effects: e.effects.slice(0, i + 1), normalize: { ...e.normalize, mode: "off" } };
}

interface Made {
  readonly mips: PeakMips;
  readonly pcm: PcmFrames;
  readonly key: string;
  readonly bytes: number;
}

/** Renders made, by path and render inputs. */
const made = signal<ReadonlyMap<string, Made>>(new Map());
const failed = new Set<string>();
let wanted: { id: string; run: () => Promise<void> } | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const SETTLE_MS = 250;

function pump(): void {
  if (running || !wanted) return;
  const job = wanted;
  wanted = null;
  running = true;
  void job.run().finally(() => {
    running = false;
    pump();
  });
}

/** Ask for a render (the newest ask replaces one not started yet). */
function want(id: string, run: () => Promise<void>): void {
  if (wanted?.id === id) return;
  wanted = { id, run };
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, SETTLE_MS);
}

/**
 * The preview of `session` with edits `e` (focused on effect `focus`), starting its render when it isn't made yet.
 * Read while drawing: it never writes a signal synchronously.
 */
export function previewOf(session: SampleSession, e: SampleEdits, focus: string | null, ab: boolean): Preview {
  if (ab || !hasRenderableEdits(editsUpTo(e, focus))) return { state: e.frozen ? "frozen" : "source", mips: null, pcm: null, key: null, bytes: 0 };
  const edits = editsUpTo(e, focus);
  const source = session.source.value;
  const id = `${source}\n${renderInputs(edits)}`;
  const have = made.value.get(id);
  if (have) return { state: e.frozen ? "frozen" : "cached", mips: have.mips, pcm: have.pcm, key: have.key, bytes: have.bytes };
  if (!failed.has(id)) {
    const project = session.project;
    want(id, async () => {
      try {
        const bytes = await bytesOf(project, source);
        const r = await cachedRender(projectRenderStore(project), bytes, edits, () => pcmOf(project, source), renderInBackground);
        const pcm = await decodeAudio(project, r.bytes, "render.wav");
        const next = new Map(made.peek());
        next.set(id, { mips: peaksOfPcm(pcm), pcm, key: r.key, bytes: r.bytes.length });
        made.value = next;
      } catch {
        failed.add(id);
        made.value = new Map(made.peek());
      }
    });
  }
  // While rebuilding, the last render of this sample stays up (or the source).
  const last = [...made.value.entries()].reverse().find(([k]) => k.startsWith(`${source}\n`))?.[1] ?? null;
  return { state: e.frozen ? "frozen" : failed.has(id) ? "source" : "rebuilding", mips: last?.mips ?? null, pcm: last?.pcm ?? null, key: null, bytes: 0 };
}
