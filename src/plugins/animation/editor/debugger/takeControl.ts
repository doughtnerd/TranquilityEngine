// Opening a take in the animation debugger (ADR 0348, 0373; T73): reads a take file from the project, decodes its animation
// records (the audio plugin's take reader, loaded only now, hands them over), and holds the source over it. The source
// (`takeSource.ts`) replaces the play session's and a connected build's in the graph editor while a take is open
// (`register.ts` follows `openedTake`).
import { signal } from "@preact/signals";
import { readAnimationTake, type AnimationTake } from "../../runtime/features/debug/takeRead";
import type { TakeExtensionRecord } from "../../../../engine/audio/take/extensions";
import { createTakeSource, type TakeDebugSource, type TakeSession } from "./takeSource";

/** The take open now (its project path and source), or null. */
export const openedTake = signal<{ readonly path: string; readonly source: TakeDebugSource } | null>(null);
/** A take is being read. */
export const takeBusy = signal(false);
/** Why the last open failed (null: it didn't). */
export const takeError = signal<string | null>(null);

/** Reads a take file's animation records: the take, or why it can't be debugged. */
export async function readTake(bytes: Uint8Array): Promise<AnimationTake | { refused: string }> {
  let extensions: TakeExtensionRecord[];
  try {
    const { readTakeExtensions } = await import("../../../audio/runtime");
    extensions = (await readTakeExtensions(bytes)).extensions;
  } catch (err) {
    return { refused: `This file isn't a take the editor can read (${err instanceof Error ? err.message : String(err)}).` };
  }
  const take = readAnimationTake(extensions);
  if (take.targets.length === 0) return { refused: take.problems[0] ?? "This take has no animation in it: no graph Animator ran while it recorded." };
  return take;
}

/** Opens the take file `path` of the project (its bytes from `load`); on success it is `openedTake`. */
export async function openTake(path: string, load: () => Promise<Uint8Array>, session: TakeSession): Promise<void> {
  if (takeBusy.peek()) return;
  takeBusy.value = true;
  takeError.value = null;
  try {
    const take = await readTake(await load());
    if ("refused" in take) {
      takeError.value = take.refused;
      return;
    }
    closeTake();
    openedTake.value = { path, source: createTakeSource(take, session, path.replace(/^.*\//, "")) };
  } catch (err) {
    takeError.value = `The take couldn't be read (${err instanceof Error ? err.message : String(err)}).`;
  } finally {
    takeBusy.value = false;
  }
}

/** Closes the open take and shows the running game again. */
export function closeTake(): void {
  const open = openedTake.peek();
  if (!open) return;
  open.source.dispose(); // puts a shown pose back
  openedTake.value = null;
}
