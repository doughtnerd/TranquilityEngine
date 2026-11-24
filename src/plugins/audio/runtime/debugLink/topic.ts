// The debug link's `audio` topic (ADR 0376's audio topics, 0348, ADR 0403 plan C4; schema in `schema.ts`), served by a
// build with debugging on to the Audio Studio and the editor, on the reliable channel:
//
// - subscription `{ kind: "capture" }`: the live capture feed (`capture.ts`);
// - subscription `{ kind: "upload", upload }`: an upload's chunks (`upload.ts`);
// - subscription `{ kind: "take" }`: the take's state as it changes, the tool owning the build's takes, and a backup copy
//   of each stopped take kept in app data on desktop and Android (`takeState.ts`, ADR 0407);
// - requests `take.start`, `take.stop`, `take.mark` `{ text }`: drive `Audio.take`, answered by the take's state and
//   seconds after it; `take.upload`: makes the take's file bytes into an upload (`upload.ts`);
// - command `mix.op`: one live mix op, applied through the mixer at the build's next frame start (`mixCommands.ts`).
//
// Loaded only by `import()` from the plugin's registration (`../index.ts`), so release exports hold none of it.
import { mixer } from "../../../../engine/audio/mixer";
import { isTauri } from "../../../../engine/platform/FileSystem";
import type { DebugSubscription, DebugTopic, DebugTopicHost } from "../../../../engine/debugLink/topics";
import { captureLiveHost } from "../capture/capture";
import { audioTake, takeFileBytes } from "../capture/take";
import { captureSubscription } from "./capture";
import { applyMixOpCommand } from "./mixCommands";
import { takeStateSubscription } from "./takeState";
import { AUDIO_TOPIC_CHANNEL, AudioRequest, MIX_OP_COMMAND, readAudioSubscription, type TakeStateReply, type TakeUploadParams } from "./schema";
import { createTakeUploads, type TakeUploads } from "./upload";

/**
 * ADR 0407: the build's own copy of a take it handed to the tool, in case the stream is interrupted: an auto-named
 * `<app data>/takes/*.mycotake`, in the newest-16 rotation. Desktop and Android only (a browser would download it).
 */
function backupTake(): void {
  audioTake.save().catch((err: unknown) => console.warn(`[myco] couldn't keep a copy of the take: ${err instanceof Error ? err.message : String(err)}`));
}

/** The take after a request. */
function takeState(): TakeStateReply {
  return { state: audioTake.state, seconds: audioTake.seconds };
}

/** @internal The audio topic for a build's link. */
export function audioTopic(_host: DebugTopicHost): DebugTopic {
  let uploads: TakeUploads | null = null;
  const theUploads = (): TakeUploads => (uploads ??= createTakeUploads({ bytes: takeFileBytes, seconds: () => audioTake.seconds }));

  return {
    channel: AUDIO_TOPIC_CHANNEL,
    subscribe(params): DebugSubscription | { refused: string } {
      const p = readAudioSubscription(params);
      if ("refused" in p) return p;
      if (p.kind === "capture") return captureSubscription(captureLiveHost);
      if (p.kind === "take") return takeStateSubscription(takeState, isTauri() ? backupTake : undefined);
      return theUploads().subscribe(p.upload);
    },
    async request(method, params) {
      switch (method) {
        case AudioRequest.start:
          await audioTake.start();
          return takeState();
        case AudioRequest.stop:
          audioTake.stop();
          return takeState();
        case AudioRequest.mark: {
          const text = params && typeof params === "object" ? (params as Record<string, unknown>).text : undefined;
          if (typeof text !== "string") throw new Error("take.mark needs the marker's text");
          audioTake.mark(text);
          return takeState();
        }
        case AudioRequest.upload:
          return theUploads().begin((params && typeof params === "object" ? params : {}) as TakeUploadParams);
        default:
          throw new Error(`The audio topic has no "${method}" request.`);
      }
    },
    command(name, params) {
      if (name !== MIX_OP_COMMAND) throw new Error(`The audio topic has no "${name}" command.`);
      applyMixOpCommand(params, mixer);
    },
    dispose() {
      uploads?.dispose();
      uploads = null;
    },
  };
}
