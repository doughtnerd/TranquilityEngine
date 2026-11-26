// ADR 0348: opening a take file (`*.sporesample`). A take is a capture file with the `take` header flag, META's `take`
// section and request records in its stream; this opens it with the capture reader (every check, every refusal, the
// profile records as `Audio.capture` would have them) and collects the request records the reader checks, then builds the
// replay's view (`engine/audio/take/reader.ts` `Take`) with the take assembler (`engine/audio/take/assembler.ts`, ADR 0417),
// which reads META by the same rules a live take's does. The Profiler opens the same file as a capture (`openCapture`),
// passing over the requests.
import type { TakeExtensionRecord } from "../../../../engine/audio/take/extensions";
import { TakeAssembler } from "../../../../engine/audio/take/assembler";
import type { Take } from "../../../../engine/audio/take/reader";
import type { TakeRecord } from "../../../../engine/audio/take/records";
import { CAPTURE_FLAG_TAKE, CaptureError, readCaptureHeader } from "./format";
import { openCapture, type CaptureContents, type ReaderOptions } from "./reader";

/** An opened take: the replay's view and the profile (the capture reader's contents of the same file). */
export interface OpenedTake {
  take: Take;
  profile: CaptureContents;
  /** The plugin records the take holds (types 0x40..0x7e), in file order; the plugin that wrote them decodes them. */
  extensions: TakeExtensionRecord[];
}

/**
 * Opens a take file, all or nothing: the capture reader's refusals (`CaptureError`), plus `badHeader` for a capture that
 * is not a take and `badMeta` for a take whose META `take` section is missing or malformed.
 */
export async function openTakeFile(file: Uint8Array, opts: ReaderOptions = {}): Promise<OpenedTake> {
  const header = readCaptureHeader(file);
  if ((header.flags & CAPTURE_FLAG_TAKE) === 0) throw new CaptureError("badHeader", 10, "a capture, not a take (no take flag): open it in the Profiler");
  const records: TakeRecord[] = [];
  const extensions: TakeExtensionRecord[] = [];
  const profile = await openCapture(file, {
    ...opts,
    onRequestRecord: (r, seq) => {
      records.push(r);
      opts.onRequestRecord?.(r, seq);
    },
    onExtensionRecord: (r) => {
      extensions.push(r);
      opts.onExtensionRecord?.(r);
    },
  });
  const { meta } = profile;
  const assembler = new TakeAssembler({ project: meta.project.name, engine: meta.engine, device: meta.device.userAgent, startedMs: header.startDateMs });
  for (const r of records) assembler.add(r);
  const take: Take | string = assembler.finished(meta.take);
  if (typeof take === "string") throw new CaptureError("badMeta", 0, take);
  return { take, profile, extensions };
}
