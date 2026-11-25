// The audio topic's `take` subscription (ADR 0408, schema in `schema.ts`): the take's state now and each time it
// changes, as `AUDIO_TAKE_STATE` records. It reads the state at each sample, so a take started or stopped any way (F10,
// the game's script, a request) is seen without hooks in the take. While open it claims the build's takes
// (`takeClaims.ts`): F10 then leaves saving to the tool, and the build only keeps a backup copy of each take it stops.
import type { RecordWriter } from "../../../../engine/debugLink/records";
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import { claimTakes } from "../capture/takeClaims";
import { AudioLinkRecord, encodeTakeState, type TakeStateReply } from "./schema";

/**
 * The subscription over `read` (the take's state and seconds now). `backup`, when given, runs each time a take stops
 * while the subscription is open, however it stopped: the build keeps its own copy of every take it hands the tool, in
 * case the stream is interrupted (ADR 0408; the desktop and Android builds save it to app data, in the usual rotation).
 */
export function takeStateSubscription(read: () => TakeStateReply, backup?: () => void): DebugSubscription {
  const release = claimTakes();
  let sent: string | null = null;
  let seq = 0;
  return {
    sample(out: RecordWriter, frame: number) {
      const now = read();
      if (now.state === sent) return;
      if (sent === "recording" && now.state === "stopped") backup?.();
      sent = now.state;
      out.write(AudioLinkRecord.takeState, seq++, frame, encodeTakeState(now));
    },
    close: release,
  };
}
