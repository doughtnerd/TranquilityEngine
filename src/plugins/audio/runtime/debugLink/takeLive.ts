// The audio topic's `takeLive` subscription, build side (schema in `schema.ts`): the live take feed, a picture of what the
// game asks of audio while a take records, however it was started (the Studio, F10, the game's script). A take's request
// records, keyframes and pictures live in the take recorder's own log (`capture/takeRecorder.ts`), not the capture ring,
// so the capture feed doesn't carry them; this reads that log from where it last stopped at each sample (`takeLive()` in
// `capture/take.ts`, which reaches the recorder only through the take's lazy loading) and sends what is new:
//
// - a take not sent yet (a new id): one `takeLiveStart` record, its META facts, and the feed starts over;
// - emitters it named since: `takeLiveEmitters` records (only the new names, cut to fit a sample);
// - its log from the last byte sent: `takeLiveLog` pieces of at most `TAKE_LIVE_LOG_BYTES`, cut at any byte (a picture of
//   up to 240 KiB spans several pieces); while it records and nothing new was logged, an empty piece a few times a second
//   so the take's clock moves;
// - once it stopped and its whole log is out: one `takeLiveEnd` record (META's take section, why it stopped).
//
// Each sample holds whole records totalling at most `AUDIO_SAMPLE_BYTES`; the reliable channel samples again while a
// sample writes, so a backlog drains in a few frames. Nothing is claimed: the build's F10 and saving are unchanged.
// Loaded only by `import()` (through `topic.ts`), so release exports hold none of it.
import { RECORD_HEAD_BYTES, type RecordWriter } from "../../../../engine/debugLink/records";
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import type { TakeLiveView } from "../capture/take";
import {
  AUDIO_SAMPLE_BYTES, AudioLinkRecord, TAKE_LIVE_LOG_BYTES, TAKE_LIVE_LOG_HEAD_BYTES, encodeTakeLiveEmitters, encodeTakeLiveEnd, encodeTakeLiveLog, encodeTakeLiveStart,
} from "./schema";

/** While a take records with nothing new logged, its clock is sent at most this often, seconds. */
const CLOCK_SECONDS = 0.25;
/** Room a JSON record's braces and take id take beside its entries (generous). */
const JSON_OVERHEAD = 64;

const utf8 = new TextEncoder();

/** The live take feed over `read` (the running take, else the last one kept, or null: `takeLive` in `capture/take.ts`). */
export function takeLiveSubscription(read: () => TakeLiveView | null): DebugSubscription {
  let take = -1;
  let offset = 0;
  let sentEmitters = new Set<string>();
  let emitterCount = 0;
  let clock = -Infinity;
  let ended = false;
  let seq = 0;

  return {
    sample(out: RecordWriter, frame: number): void {
      const v = read();
      if (!v) return;
      let used = 0;
      const put = (type: number, payload: Uint8Array): void => {
        out.write(type, seq++, frame, payload);
        used += RECORD_HEAD_BYTES + payload.byteLength;
      };
      const room = (): number => AUDIO_SAMPLE_BYTES - used - RECORD_HEAD_BYTES;

      if (v.id !== take) {
        take = v.id;
        offset = 0;
        sentEmitters = new Set();
        emitterCount = 0;
        clock = -Infinity;
        ended = false;
        put(AudioLinkRecord.takeLiveStart, encodeTakeLiveStart({ take, ...v.facts }));
      }
      if (ended) return;

      // Emitters first: a record in the log may name one.
      if (v.log.emitterCount !== emitterCount) {
        const names = v.log.namedEmitters();
        let batch: Record<string, string> = {};
        let batchBytes = JSON_OVERHEAD;
        let pending = false;
        for (const [id, name] of Object.entries(names)) {
          if (sentEmitters.has(id)) continue;
          const size = utf8.encode(JSON.stringify(id) + JSON.stringify(name)).byteLength + 2;
          if (batchBytes + size > room()) {
            if (pending) put(AudioLinkRecord.takeLiveEmitters, encodeTakeLiveEmitters({ take, emitters: batch }));
            batch = {};
            batchBytes = JSON_OVERHEAD;
            pending = false;
            if (JSON_OVERHEAD + size > room()) return; // the rest next sample
          }
          batch[id] = name;
          batchBytes += size;
          pending = true;
          sentEmitters.add(id);
        }
        if (pending) put(AudioLinkRecord.takeLiveEmitters, encodeTakeLiveEmitters({ take, emitters: batch }));
        emitterCount = v.log.emitterCount;
      }

      let logged = false;
      while (offset < v.log.bytes) {
        const space = Math.min(TAKE_LIVE_LOG_BYTES, room() - TAKE_LIVE_LOG_HEAD_BYTES);
        if (space <= 0) return; // the rest next sample
        const bytes = v.log.readLog(offset, space);
        if (bytes.byteLength === 0) break;
        put(AudioLinkRecord.takeLiveLog, encodeTakeLiveLog({ take, offset, seconds: v.seconds, bytes }));
        offset += bytes.byteLength;
        logged = true;
      }
      if (logged) clock = v.seconds;

      if (v.recording) {
        if (v.seconds - clock >= CLOCK_SECONDS && room() >= TAKE_LIVE_LOG_HEAD_BYTES) {
          put(AudioLinkRecord.takeLiveLog, encodeTakeLiveLog({ take, offset, seconds: v.seconds, bytes: new Uint8Array(0) }));
          clock = v.seconds;
        }
        return;
      }
      if (v.section && offset >= v.log.bytes && room() >= 1024) {
        put(AudioLinkRecord.takeLiveEnd, encodeTakeLiveEnd({ take, section: v.section, message: v.message }));
        ended = true;
      }
    },
    close(): void {},
  };
}
