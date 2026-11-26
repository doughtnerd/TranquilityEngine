// ADR 0171 amended by 0172 (M5a, task Pf8; api-and-models §7, §5): the words for every capture refusal.
// `captureErrorMessage` has one headline per `CaptureError` code in `capture/format.ts` (a `Record` over `CaptureErrorCode`,
// so a new code is a type error here until it has a message), and it appends the reader's own detail, which for
// `newerFormat`, `olderFormat` and `wireMismatch` names both versions. The Audio Studio's Profiler and Take screens show
// them. Pure.
import type { CaptureErrorCode } from "../../runtime/capture/reader";

/** Codes an open adds beside the reader's: a file that isn't a capture (not `.sporesample`), and any other failure. */
export type OpenRouteCode = "notCapture" | "open";

/** One headline per code. The reader's detail follows it (`captureErrorMessage`), so a headline says what it means and what to do. */
const CAPTURE_ERROR_HEADLINES: Readonly<Record<CaptureErrorCode, string>> = {
  badMagic: "Not a Myco capture file.",
  newerFormat: "This capture was saved by a newer version of Myco; update this editor to open it.",
  olderFormat: "This capture was saved by an older version of Myco that this build no longer reads; re-record it with this build.",
  wireMismatch: "This capture was recorded by an audio core whose records are laid out differently at the same version, so they can't be read.",
  tooLarge: "This capture is larger than this build can open.",
  inflateOverrun: "The capture's data is bigger than its header says; the file is damaged or not trusted.",
  badHeader: "The capture's header is invalid.",
  inflateFailed: "The capture's compressed data is corrupt.",
  sizeMismatch: "The capture's data length doesn't match its header; the file is cut short or damaged.",
  metaTooLarge: "The capture's description block is too large.",
  badMeta: "The capture's description block is invalid.",
  badUtf8: "The capture holds text that is not valid UTF-8.",
  textTooLong: "The capture holds a name or marker that is too long.",
  tooManyNames: "The capture holds more names than this build reads.",
  truncatedRecord: "The capture ends in the middle of a record; the file is cut short.",
  recordTooLarge: "The capture holds a record larger than this build reads.",
  tooManyRecords: "The capture holds more records than its header says.",
  countMismatch: "The capture holds fewer records than its header says; the file is cut short.",
  unknownRequired: "The capture uses a record type this build doesn't know.",
  badLength: "A record in the capture has the wrong length.",
  badValue: "A record in the capture holds a value out of range.",
  badRecord: "A record in the capture is invalid.",
  badSeq: "The capture's records are out of order (sequence numbers).",
  badEpoch: "The capture's records are out of order (epochs).",
  badFrame: "A record in the capture has an invalid time.",
  disorder: "The capture's records are out of time order.",
  badIndex: "The capture's index is invalid.",
  cancelled: "The open was cancelled.",
};

/** The open's own codes. */
const OPEN_ROUTE_HEADLINES: Readonly<Record<OpenRouteCode, string>> = {
  notCapture: "Not a capture file.",
  open: "The file couldn't be opened.",
};

/** The headline of `code`, or null for a code this build has no words for. */
function headlineOf(code: string): string | null {
  if (Object.prototype.hasOwnProperty.call(CAPTURE_ERROR_HEADLINES, code)) return CAPTURE_ERROR_HEADLINES[code as CaptureErrorCode];
  if (Object.prototype.hasOwnProperty.call(OPEN_ROUTE_HEADLINES, code)) return OPEN_ROUTE_HEADLINES[code as OpenRouteCode];
  return null;
}

/**
 * The message for a refusal: `<headline> (<code>) <detail>`. `detail` is the reader's message without its "code at offset"
 * prefix; for the version codes it names both sides ("capture format 2 is newer than this build's 1", "recorded with audio
 * ABI x ...; this build is ABI y"). An unknown code still shows its code and detail.
 */
export function captureErrorMessage(code: string, detail: string): string {
  const head = headlineOf(code);
  const tail = detail.trim();
  return [head, `(${code})`, tail].filter((s) => s !== null && s !== "").join(" ");
}

