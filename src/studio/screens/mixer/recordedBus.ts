// A bus as the open take recorded it at the replay's playhead, for the Mixer screen and the Take screen's Mixer panel:
// the take's profile is open on the Profiler (opening a take opens both, `takeScreen.ts`) and its cursor follows the
// replay (`reviewLink.ts`), so its seek is the moment; `recordedLevels.ts` reads the bus from it. Subscribes in a render.
import { captureNames } from "../../../plugins/audio/runtime/capture/reader";
import { replayStore } from "../../shell/replay";
import { profilerStore } from "../profiler/profilerScreen";
import { takeOfCapture } from "../profiler/reviewLink";
import type { BusReading } from "./boardModel";
import { recordedBusReading } from "./recordedLevels";

/** Each open profile's names, built once (every meter asks each frame). */
const namesOf = new WeakMap<object, ReturnType<typeof captureNames>>();

/** Bus `name` as the open take recorded it at the playhead; null with no take open, its profile not (yet) open, or no reading. */
export function recordedBus(name: string): BusReading | null {
  const open = replayStore().open.value;
  const store = profilerStore();
  const seek = store.seek.value;
  const source = store.source;
  if (!open || !seek || !source || takeOfCapture(store.state.value) !== open.path) return null;
  let names = namesOf.get(source.summary);
  if (!names) namesOf.set(source.summary, (names = captureNames(source.summary)));
  return recordedBusReading(seek, (slot, at) => names.bus(slot, at), name);
}
