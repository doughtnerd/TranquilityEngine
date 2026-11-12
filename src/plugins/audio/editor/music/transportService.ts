// F-33: the lifetime of the music audition. The transport is one per editor and the audition outlives any panel: the
// segment view and Segment Properties share a dock tab group, and a tab switch unmounts the view, which must not stop
// the sound (the panel's solo and mute are heard at once). The audition stops on: an explicit Stop, a new audition
// (one at a time, `setActiveAudition`), the editor's play mode starting, the audition's event leaving the project (the
// document closes), or the segment view moving on to another segment. This service also owns the display tick and the
// panel's solo/mute -> audible-stems sync, both of which used to live in the view's effects.
import { effect, type ReadonlySignal } from "@preact/signals";
import type { Transport } from "./transport";

export interface TransportServiceDeps {
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

/** Start the lifetime rules for `transport`; the returned function stops them (tests). */
export function startTransportService(transport: Transport, deps: TransportServiceDeps): () => void {
  const live = (): boolean => { const p = transport.state.peek().phase; return p === "playing" || p === "released"; };
  const disposers: (() => void)[] = [];

  // The display tick runs while something plays, whatever panel is up.
  disposers.push(effect(() => {
    const phase = transport.state.value.phase;
    if (phase !== "playing" && phase !== "released") return;
    const t = setInterval(() => transport.tick(), deps.tickMs ?? 50);
    return () => clearInterval(t);
  }));

  // The event document closes (or the project does).
  disposers.push(effect(() => {
    const event = transport.state.value.event;
    const files = deps.files();
    if (event !== null && live() && (!files || !files.includes(event))) transport.stop();
  }));

  // Play mode takes the audio over.
  disposers.push(effect(() => {
    if (deps.playMode.value && live()) transport.stop();
  }));

  // The view moves to another segment: the audition of the one it left stops.
  let prev = deps.open.peek();
  disposers.push(effect(() => {
    const next = deps.open.value;
    const left = prev;
    prev = next;
    if (!left || (next && next.event === left.event && next.segmentId === left.segmentId)) return;
    const s = transport.state.peek();
    if (live() && s.event === left.event && s.segmentId === left.segmentId) transport.stop();
  }));

  // The segment panel's solo and mute reach the playing music, view mounted or not.
  disposers.push(effect(() => {
    const a = deps.audible();
    if (a) transport.setAudibleStems(a.segmentId, a.audible);
  }));

  return () => { for (const d of disposers.splice(0)) d(); };
}
