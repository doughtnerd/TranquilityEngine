// ADR 0337 §7 (W12 package integration): the core backend's `AudioPacks` capability. A package's bytes go to the decoder
// worker (`DecoderClient.loadPack`, with the build URL's re-fetch for a restarted worker), and its arena-resident sounds
// are committed to the clip arena at load: a hold is a clip registry reference (the whole clip, or a `stream` sound's
// prefetch head as the span `[0, frames)`), so the clip stays loaded while the package holds it, whatever voices do, and
// unloads one frame after the hold and the last voice let go. The registry decodes each from the package itself
// (`packMedia.ts` `clipPackRef`), never fetching.
import type { AudioPacks, PackClipHold } from "../backend";
import type { DecoderClient } from "../decoder/decoderClient";
import type { ClipRegistry } from "./clipRegistry";

/** What the capability needs of the backend. */
export interface PackHostDeps {
  /** The decoder client the backend's clips and streams use. */
  readonly decoder: () => Partial<Pick<DecoderClient, "loadPack" | "releasePack">>;
  readonly clips: ClipRegistry;
  /** Whether the output is locked (no user gesture yet): the core runs no quantum, so no clip turns resident. */
  readonly locked: () => boolean;
}

/** How often a hold looks again while the output is locked, ms. */
const LOCKED_POLL_MS = 30;

export function createPackHost(deps: PackHostDeps): AudioPacks {
  const { clips } = deps;
  return {
    async loadPack(pack, bytes, refetch) {
      const decoder = deps.decoder();
      if (!decoder.loadPack) throw new Error("audio: this decoder can't hold packages");
      await decoder.loadPack(pack, bytes, { refetch });
    },
    releasePack(pack) {
      deps.decoder().releasePack?.(pack);
    },
    holdClip(path, frames): PackClipHold {
      const span = frames !== undefined && frames > 0 && clips.acquireSpan;
      let id = span ? clips.acquireSpan!(path, 0, frames) : clips.acquire(path);
      const stateOf = (): PackClipHold["state"] => {
        if (id === 0) return "failed";
        const st = clips.state(id);
        return st === "ready" ? "ready" : st === "failed" ? "failed" : "loading";
      };
      let settledOnce: Promise<void> | null = null;
      return {
        get state() {
          return stateOf();
        },
        get bytes() {
          if (id === 0) return 0;
          const info = clips.info(id);
          return info && info.state !== "failed" ? info.bytes : 0;
        },
        settled() {
          if (settledOnce) return settledOnce;
          settledOnce = new Promise<void>((resolve) => {
            if (id === 0) return resolve();
            let done = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            let off: () => void = () => {};
            const finish = () => {
              if (done) return;
              done = true;
              off();
              if (timer !== null) clearTimeout(timer);
              resolve();
            };
            off = clips.onResident(id, finish);
            // Locked: the copy is queued (CLIP_BEGIN sent) and the core takes it in at its first quantum.
            const poll = () => {
              timer = null;
              if (done) return;
              if (id === 0 || (deps.locked() && clips.state(id) === "copying")) return finish();
              timer = setTimeout(poll, LOCKED_POLL_MS);
            };
            if (!done) poll();
          });
          return settledOnce;
        },
        release() {
          if (id !== 0) clips.release(id);
          id = 0;
        },
      };
    },
  };
}
