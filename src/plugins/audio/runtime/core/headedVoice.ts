// ADR 0351 §3 "Prefetch" (W12): a packaged `stream` sound starts on its prefetch head and hands over to its stream ring.
// The head is a span clip `[0, H)` already resident in the arena (the package committed it at load); the play is two core
// voices on one clock: the head as a clip voice stamped at T0 (the earliest exact frame, so it starts at once), and the
// stream opened at file frame H as a stream voice stamped at T0 + H / (rate × pitch), so its first frame follows the
// head's last on the same output frame. Both are stamped PLAYs (ADR 0158), so the seam is sample-accurate at the file's
// own rate with no core change; the ring has the head's length to fill (the worker fetches, opens and decodes meanwhile).
//
// Callers get one `CoreVoice`: every call goes to both voices while the head plays (to the stream alone after), and
// what it reads comes from the stream voice, except `playing` and `reason` while the head is the one sounding. A seek
// during the head drops the head (the stream seeks); a pitch change or a pause during the head can move the seam by the
// difference (the stream's stamp is fixed), which a head of a few hundred milliseconds rarely meets.
import type { CoreVoice } from "./coreBackend";

/** The fade a seek during the head stops the head with, seconds. */
const HEAD_DROP_FADE = 0.005;

/** Members that read state: from the head while it sounds (the stream voice is only scheduled then). */
const FROM_HEAD = new Set<PropertyKey>(["reason"]);

/** `head` then `body` as one voice (see the header). */
export function headedVoice(head: CoreVoice, body: CoreVoice): CoreVoice {
  let headLive = true;
  const sounding = (): boolean => {
    if (headLive) {
      try {
        headLive = head.playing;
      } catch {
        headLive = false;
      }
    }
    return headLive;
  };
  const proxy: CoreVoice = new Proxy(body, {
    get(target, prop) {
      if (prop === "handle") return proxy;
      if (prop === "playing") return sounding() || target.playing;
      if (prop === "alive") return sounding() || (target.alive ?? target.playing);
      if (FROM_HEAD.has(prop) && sounding()) return Reflect.get(head, prop, head);
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (sounding()) {
          if (prop === "seek") {
            headLive = false;
            head.stop(HEAD_DROP_FADE);
          } else {
            const own = Reflect.get(head, prop, head);
            if (typeof own === "function") (own as (...a: unknown[]) => unknown).apply(head, args);
          }
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return proxy;
}
