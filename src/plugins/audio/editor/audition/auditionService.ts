// The audition's lifetime rules (ADR 0268, from 0166's F-33). The audition is one per editor and outlives any panel: the
// segment view and Segment Properties share a dock tab group, and a tab switch unmounts the view, which must not stop the
// sound. Whatever started it (the Event editor, the segment view, the rules table), the audition stops on: an explicit
// Stop, a new Play (one at a time), the editor's play mode starting, its event leaving the project (the document closes),
// or the segment view moving on from the segment it auditions; the Event editor's panel stops its own whole-event
// audition when it closes. A play still flushing counts: it is cancelled, never started after its document closed. This
// service also owns the one display tick and the segment panel's solo/mute -> audible-stems sync.
import { effect, type ReadonlySignal } from "@preact/signals";
import { isLive, type Audition } from "./audition";

export interface AuditionServiceDeps {
  /** The segment open in the segment view (event path and segment id), or null. */
  readonly open: ReadonlySignal<{ readonly event: string; readonly segmentId: string } | null>;
  /** A truthy value while the editor's play mode runs. */
  readonly playMode: ReadonlySignal<unknown>;
  /** The project's file paths (read reactively), or null when no project is open. */
  readonly files: () => readonly string[] | null;
  /** The stems that sound in the open segment (read reactively; null: all), or undefined when no segment is open. */
  readonly audible: () => { readonly segmentId: string; readonly audible: readonly string[] | null } | undefined;
  readonly tickMs?: number;
}

/** Start the lifetime rules for `audition`; the returned function stops them. */
export function startAuditionService(audition: Audition, deps: AuditionServiceDeps): () => void {
  const busy = (): boolean => { const s = audition.state.peek(); return s.starting || isLive(s.phase); };
  const disposers: (() => void)[] = [];

  // The display tick runs while something plays, whatever panel is up.
  disposers.push(effect(() => {
    if (!isLive(audition.state.value.phase)) return;
    const t = setInterval(() => audition.tick(), deps.tickMs ?? 50);
    return () => clearInterval(t);
  }));

  // The event document closes (or the project does).
  disposers.push(effect(() => {
    const { event } = audition.state.value;
    const files = deps.files();
    if (event !== null && busy() && (!files || !files.includes(event))) audition.stop();
  }));

  // Play mode takes the audio over when it starts.
  disposers.push(effect(() => {
    if (deps.playMode.value && busy()) audition.stop();
  }));

  // The view moves to another segment: the audition of the one it left stops.
  let prev = deps.open.peek();
  disposers.push(effect(() => {
    const next = deps.open.value;
    const left = prev;
    prev = next;
    if (!left || (next && next.event === left.event && next.segmentId === left.segmentId)) return;
    audition.stop({ event: left.event, segmentId: left.segmentId });
  }));

  // The segment panel's solo and mute reach the playing music, view mounted or not.
  disposers.push(effect(() => {
    const a = deps.audible();
    if (a) audition.setAudibleStems(a.segmentId, a.audible);
  }));

  return () => { for (const d of disposers.splice(0)) d(); };
}
