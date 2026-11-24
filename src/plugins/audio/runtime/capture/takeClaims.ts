// ADR 0408: a tool connected over the debug link (the Audio Studio) can own the build's takes. While one holds a claim,
// the build's F10 trigger only starts and stops takes and saves nothing itself; the tool uploads the stopped take and
// saves it where it decides. The audio topic's `take` subscription holds a claim while it is open.

let claims = 0;

/** Claim the build's takes; returns the release (calling it again does nothing). */
export function claimTakes(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

/** True while a tool owns the build's takes. */
export const takesClaimed = (): boolean => claims > 0;
