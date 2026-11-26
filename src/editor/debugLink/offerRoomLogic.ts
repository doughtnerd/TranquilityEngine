// The Offer a room dialog without its view (ADR 0404): the line each state of an offer shows, the sentence telling the
// person where the code goes, and how long the dialog stays after a build joined.
import type { OfferedRoom } from "./editorLink";

export type OfferState = OfferedRoom["state"]["value"];

/** How long the dialog stays after a build joined, so the person sees it did (ms). */
export const JOINED_CLOSE_MS = 1500;

/** The state line shown (and announced) for a state. */
export function offerStateText(state: OfferState): string {
  switch (state.kind) {
    case "opening":
      return "Opening a room…";
    case "waiting":
      return "Waiting for a build to join.";
    case "joined":
      return "A build joined; connecting…";
    case "retrying":
      return `Couldn't reach the rendezvous (${state.why}). Trying again…`;
    case "unavailable":
      return state.why;
  }
}

/** The room code to show for a state: the offer's own in upper case, or null when none is open. */
export function shownCode(code: string | null, state: OfferState): string | null {
  return state.kind === "waiting" && code ? code.toUpperCase() : null;
}

/** The one-line instruction beside the code. */
export function offerInstruction(code: string | null): string {
  const c = code ?? "<code>";
  return `Open the game with ?debug-code=${c} in its address, or launch it with --debug-code ${c}.`;
}

/** Whether the state is a problem (shown in the danger colour). */
export function offerProblem(state: OfferState): boolean {
  return state.kind === "retrying" || state.kind === "unavailable";
}
