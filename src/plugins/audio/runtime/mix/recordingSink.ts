// Test support (ADR 0171, Rc3): a `ProfileSink` that pushes every tap into an array, for the tests of the taps. The real
// recorder's encoder is `capture/events.ts`; the taps' tests use this stub so they pin what is called, not how it is encoded.
import { NULL_PROFILE_SINK, type ProfileSink } from "./profileSink";

/** One tap: the method name, then its arguments. */
export type TapCall = [kind: keyof ProfileSink, ...args: unknown[]];

/** A sink that records each call in `calls`. */
export function recordingSink(): { sink: ProfileSink; calls: TapCall[]; of(kind: keyof ProfileSink): unknown[][]; clear(): void } {
  const calls: TapCall[] = [];
  const sink: Record<string, unknown> = {};
  for (const kind of Object.keys(NULL_PROFILE_SINK)) {
    sink[kind] = (...args: unknown[]): void => {
      calls.push([kind as keyof ProfileSink, ...args]);
    };
  }
  return {
    sink: sink as unknown as ProfileSink,
    calls,
    of: (kind) => calls.filter((c) => c[0] === kind).map((c) => c.slice(1)),
    clear: () => {
      calls.length = 0;
    },
  };
}
