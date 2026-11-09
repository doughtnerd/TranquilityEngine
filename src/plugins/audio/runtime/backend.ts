/**
 * The internal audio backend interface and the `audio.backend` selector (ADR 0098, 0157 K3). The code is
 * still in `src/engine/audio/backend.ts`, because `Engine.ts` and
 * `howlerBackend.ts` (BB2 removes it) import it there and the engine must not import plugins. Once they
 * stop, move the file here and delete this re-export; plugin code imports from this path meanwhile.
 */
export * from "../../../engine/audio/backend";
