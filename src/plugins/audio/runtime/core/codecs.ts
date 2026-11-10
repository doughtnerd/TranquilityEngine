// Which files the audio core decodes, and the warnings for those it doesn't (B4; ADR 0157, api-and-models §2
// `codecs.aac`, architecture §7 "Unknown codec"). The decoder worker reads WAV, FLAC, MP3 and Ogg Vorbis always,
// and AAC (`.m4a`, `.mp4`, `.aac`) only when the project sets `audio.codecs.aac`, which makes the worker load the
// larger AAC build of the decoder. With the setting off an AAC asset is refused before it is fetched; a file the
// decoder can't open at all fails with a warning naming its format and the supported list. Each warns once per asset
// (`WarnOnce`), however many times it is played or reloaded. The Babylon fallback is not involved: the browser
// decodes there.

/** The decoder ABI's error codes for a file it can't read (`ERR_FORMAT`, `ERR_CODEC` in audio-decode's lib.rs). */
export const DECODE_ERR_FORMAT = -3;
export const DECODE_ERR_CODEC = -4;

const AAC_EXTENSIONS = new Set(["m4a", "mp4", "aac"]);

/** The extension of `path`, lower case, without the dot; "" when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** @internal Whether `path` names an AAC file (by its extension). */
export function isAacPath(path: string): boolean {
  return AAC_EXTENSIONS.has(extensionOf(path));
}

/** @internal The formats the core decodes with `aac` on or off, for messages. */
export function supportedFormats(aac: boolean): string {
  return aac ? "WAV, FLAC, MP3, Ogg Vorbis and AAC (.m4a, .mp4, .aac)" : "WAV, FLAC, MP3 and Ogg Vorbis (AAC with audio.codecs.aac on)";
}

/** @internal The warning for an AAC asset while `audio.codecs.aac` is off; null when `path` may be decoded. */
export function aacRefusal(path: string, aac: boolean): string | null {
  if (aac || !isAacPath(path)) return null;
  return `audio: "${path}" is AAC (.${extensionOf(path)}), which the audio core decodes only with audio.codecs.aac set to true (the AAC box in Project Settings > Audio); it won't play`;
}

/**
 * @internal The warning for a decode failure: for a file the decoder can't read (`code` is `DECODE_ERR_FORMAT` or
 * `DECODE_ERR_CODEC`) it names the file's format and the supported list; otherwise null (an ordinary failure, which
 * the caller reports its own way).
 */
export function unsupportedFormat(path: string, aac: boolean, code: number | undefined, detail: string): string | null {
  if (code !== DECODE_ERR_FORMAT && code !== DECODE_ERR_CODEC) return null;
  const ext = extensionOf(path);
  const format = ext ? `.${ext}` : "a file without an extension";
  return `audio: "${path}" can't be decoded: its format (${format}) isn't one the audio core reads. Supported: ${supportedFormats(aac)}. (${detail})`;
}

/** @internal Warns at most once per key. */
export type WarnOnce = (key: string, message: string) => void;

/** @internal A `WarnOnce` over `warn` with its own set of keys. */
export function createWarnOnce(warn: (message: string) => void = (m) => console.warn(m)): WarnOnce {
  const warned = new Set<string>();
  return (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  };
}
