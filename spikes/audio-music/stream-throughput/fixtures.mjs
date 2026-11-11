// Transcodes samples/flappy/music/town.mp3 (82 s of real music, FL Studio render) to 48 kHz stereo in every codec
// the engine streams, with ffmpeg. Files land in fixtures/ (git-ignored). Idempotent.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../../samples/flappy/music/town.mp3');
export const DIR = join(here, 'fixtures');
// hint: the decoder ABI's container hint (protocol.ts:12): 1 wav, 2 flac, 3 mp3, 4 ogg, 5 mp4/m4a
export const CODECS = [
  { id: 'mp3-cbr192', file: 'town-cbr192.mp3', hint: 3, args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  { id: 'mp3-vbr', file: 'town-vbr.mp3', hint: 3, args: ['-c:a', 'libmp3lame', '-q:a', '2'] },
  { id: 'mp3-cbr128', file: 'town-cbr128.mp3', hint: 3, args: ['-c:a', 'libmp3lame', '-b:a', '128k'] },
  { id: 'vorbis-q5', file: 'town-q5.ogg', hint: 4, args: ['-c:a', 'libvorbis', '-q:a', '5'] },
  { id: 'vorbis-q3', file: 'town-q3.ogg', hint: 4, args: ['-c:a', 'libvorbis', '-q:a', '3'] },
  { id: 'flac', file: 'town.flac', hint: 2, args: ['-c:a', 'flac'] },
  { id: 'wav', file: 'town.wav', hint: 1, args: ['-c:a', 'pcm_s16le'] },
  { id: 'aac-192 (aac wasm)', file: 'town-192.m4a', hint: 5, aac: true, args: ['-c:a', 'aac', '-b:a', '192k'] },
];
export function ensureFixtures() {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg not found');
  mkdirSync(DIR, { recursive: true });
  for (const c of CODECS) {
    const out = join(DIR, c.file);
    if (!existsSync(out)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', SRC, '-ar', '48000', '-ac', '2', '-map_metadata', '-1', ...c.args, out]);
  }
  return CODECS.map((c) => ({ ...c, path: join(DIR, c.file), bytes: statSync(join(DIR, c.file)).size }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) for (const c of ensureFixtures()) console.log(c.id.padEnd(22), (c.bytes / 1e6).toFixed(2), 'MB', (c.bytes * 8 / 82.34 / 1000).toFixed(0), 'kbps');
