import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const MODEL_DIR = process.env.LOD_MODELS || '/tmp/claude-0/lod-models';
// spikes/lod-simplify/lib -> worktree root
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const nodeRead = async (key) =>
  new Uint8Array(await readFile(key.startsWith('models/') ? path.join(MODEL_DIR, key.slice(7)) : path.join(ROOT, key.slice(5))));
