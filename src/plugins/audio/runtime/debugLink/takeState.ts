// The audio topic's `take` subscription (ADR 0408, schema in `schema.ts`): the take's state now and each time it
// changes, as `AUDIO_TAKE_STATE` records. It reads the state at each sample, so a take started or stopped any way (F10,
// the game's script, a request) is seen without hooks in the take. While open it claims the build's takes (take
// ownership, `capture/takeOwnership.ts`, ADR 0417): F10 then leaves saving to the tool, and the claim keeps a backup copy
// of each take it sees stop where the build keeps them.
import type { RecordWriter } from "../../../../engine/debugLink/records";
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import type { TakeOwnership } from "../capture/takeOwnership";
import { AudioLinkRecord, encodeTakeState, type TakeStateReply } from "./schema";

/** The subscription over `read` (the take's state and seconds now), holding a claim on `ownership` while open. */
export function takeStateSubscription(read: () => TakeStateReply, ownership: TakeOwnership): DebugSubscription {
  const claim = ownership.claim();
  let sent: string | null = null;
  let seq = 0;
  return {
    sample(out: RecordWriter, frame: number) {
      const now = read();
      claim.observe(now.state);
      if (now.state === sent) return;
      sent = now.state;
      out.write(AudioLinkRecord.takeState, seq++, frame, encodeTakeState(now));
    },
    close: claim.release,
  };
}
