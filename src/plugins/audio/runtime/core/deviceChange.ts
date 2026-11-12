// The `devicechange` / `statechange` / heartbeat classifier (ADR 0157; architecture §3.7, §7's "Device or rate change,
// `interrupted`" and "Worklet stall" rows; api-and-models D9). A pure function on what the host observed: it says what to
// do and touches nothing, so every row of the table is a unit test. `background.ts` gathers the observation, calls
// this, and acts on the verdict (`context.resume()`, or K6's `rebuild(reason)`).
//
// The rules, in this order (the first that matches wins):
// 1. The context is closed: `rebuild("device")`, whatever else.
// 2. The context's own sample rate differs from the one the core was built for: `rebuild("rate")`.
// 3. No STATUS for `STALL_MS` while the context runs and the page is visible: `rebuild("stall")`. A hidden page is
//    never judged stalled (frames, and in `pause` mode the whole context, are meant to stop).
// 4. Interrupted: `resume`, retried; once it has lasted `INTERRUPTED_RETRY_MS` the resume has failed: `rebuild("device")`.
// 5. Suspended, after running, with nobody having asked for it (not the page's background policy): `resume`. A
//    suspend the page asked for is left alone.
// 6. Running: Chromium follows the default output device by itself, so the answer is `leave`, unless the host probed
//    the device (on a device event only) and it runs at another rate than the context's (architecture §3.7: "rebuild at
//    the device rate"), which is `rebuild("rate")`: left alone the browser would resample for the rest of the session.
//    A device event whose rate matches, or can't be read, leaves it (D9: no rebuild just because a device came or went).
import type { RebuildReason } from "./recovery";

/** §4.7 / §7: no STATUS for this long (ms) while running and visible is a worklet stall. */
export const STALL_MS = 1_000;
/** §2.1 / §7: an `interrupted` context not resumed within this long (ms) is rebuilt. */
export const INTERRUPTED_RETRY_MS = 2_000;

/** What the host reads of the context at one moment. */
export interface DeviceSnapshot {
  /** `AudioContext.state`: "running", "suspended", "interrupted" (Safari) or "closed". */
  readonly state: string;
  /** `AudioContext.sampleRate`, Hz. */
  readonly rate: number;
  /** `AudioContext.sinkId` as a string ("" for the default device, and where unsupported). */
  readonly sink: string;
}

/** Everything the classifier looks at. */
export interface DeviceObservation {
  /** The snapshot at the previous event (or at start). */
  readonly before: DeviceSnapshot;
  /** The snapshot now. */
  readonly after: DeviceSnapshot;
  /** The rate a new context would get from the current default device, Hz; null when unknown (not probed, or no support). */
  readonly deviceRate: number | null;
  /** Milliseconds since the newest STATUS block arrived; null before the first. */
  readonly heartbeatAgeMs: number | null;
  /** Whether the page is visible. */
  readonly visible: boolean;
  /** Whether the page's own background policy suspended the context (§3.8). */
  readonly pageSuspended: boolean;
  /** How long the context has been `interrupted`, ms; 0 when it isn't. */
  readonly interruptedForMs: number;
}

/** What to do. */
export type DeviceVerdict =
  | { readonly action: "leave" }
  | { readonly action: "resume" }
  | { readonly action: "rebuild"; readonly reason: Exclude<RebuildReason, "trap" | "latency"> };

const LEAVE: DeviceVerdict = { action: "leave" };
const RESUME: DeviceVerdict = { action: "resume" };
const rebuild = (reason: Exclude<RebuildReason, "trap" | "latency">): DeviceVerdict => ({ action: "rebuild", reason });

/** §3.7: classifies one observation as leave, resume, or a rebuild and its reason. Pure. */
export function classifyDeviceChange(o: DeviceObservation): DeviceVerdict {
  const { before, after } = o;
  if (after.state === "closed") return rebuild("device");
  if (before.rate !== after.rate && after.rate > 0) return rebuild("rate");
  if (after.state === "running" && o.visible && o.heartbeatAgeMs !== null && o.heartbeatAgeMs >= STALL_MS) return rebuild("stall");
  if (after.state === "interrupted") return o.interruptedForMs >= INTERRUPTED_RETRY_MS ? rebuild("device") : RESUME;
  // A context that was never running (locked, waiting for its first gesture) is the unlock layer's, not ours.
  if (after.state === "suspended") return !o.pageSuspended && before.state === "running" ? RESUME : LEAVE;
  if (after.state === "running" && o.deviceRate !== null && o.deviceRate > 0 && o.deviceRate !== after.rate) return rebuild("rate");
  return LEAVE;
}
