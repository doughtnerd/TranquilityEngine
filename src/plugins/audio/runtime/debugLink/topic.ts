// The debug link's `audio` topic (ADR 0376's audio topics, 0348, ADR 0403 plan C4; schema in `schema.ts`), served by a
// build with debugging on to the Audio Studio and the editor, on the reliable channel:
//
// - subscription `{ kind: "capture" }`: the live capture feed (`capture.ts`);
// - subscription `{ kind: "upload", upload }`: an upload's chunks (`upload.ts`);
// - subscription `{ kind: "take" }`: the take's state as it changes, holding the tool's claim on the build's takes (and
//   with it a backup copy of each stopped take in app data on desktop and Android) (`takeState.ts`, ADR 0408, take
//   ownership `capture/takeOwnership.ts`, ADR 0417);
// - subscription `{ kind: "takeLive" }`: the live take feed, the running (else last) take's facts, emitters and log as it
//   grows (`takeLive.ts`);
// - requests `take.start`, `take.stop`, `take.mark` `{ text }`: drive `Audio.take`, answered by the take's state and
//   seconds after it (start and stop through the build's F10 trigger when installed, so the player sees the same
//   toasts, `capture/takeOwnership.ts`); `take.frames` `{ width }`: the next takes' picture width; `take.upload`: makes the take's file bytes into an upload (`upload.ts`); `build.audio` and
//   `build.file`: the build's audio index and files as uploads, for replays without the project (`buildAudio.ts`, ADR 0410);
// - command `mix.op`: one live mix op, applied through the mixer at the build's next frame start (`mixCommands.ts`).
//
// Loaded only by `import()` from the plugin's registration (`../index.ts`), so release exports hold none of it.
import { mixer } from "../../../../engine/audio/mixer";
import type { DebugSubscription, DebugTopic, DebugTopicHost } from "../../../../engine/debugLink/topics";
import { captureLiveHost } from "../capture/capture";
import { audioTake, setTakeFrameWidth, takeFileBytes, takeFrameWidth, takeLive } from "../capture/take";
import { takeOwnership } from "../capture/takeOwnership";
import { captureSubscription } from "./capture";
import { applyMixOpCommand } from "./mixCommands";
import { takeLiveSubscription } from "./takeLive";
import { takeStateSubscription } from "./takeState";
import { buildAudioIndexBytes, buildFileBytes } from "./buildAudio";
import { AUDIO_TOPIC_CHANNEL, AudioRequest, BUILD_FILE_UPLOAD_FIRST_ID, MIX_OP_COMMAND, readAudioSubscription, type TakeFramesReply, type TakeStateReply, type TakeUploadParams } from "./schema";
import { createTakeUploads, type TakeUploads } from "./upload";

/** The take after a request. */
function takeState(): TakeStateReply {
  return { state: audioTake.state, seconds: audioTake.seconds };
}

/** @internal The audio topic for a build's link. */
export function audioTopic(_host: DebugTopicHost): DebugTopic {
  let uploads: TakeUploads | null = null;
  const theUploads = (): TakeUploads => (uploads ??= createTakeUploads({ bytes: takeFileBytes, seconds: () => audioTake.seconds }));
  // ADR 0410: the build's audio index and files, one upload at a time, ids apart from the take's.
  let fileUploads: TakeUploads | null = null;
  let nextFile: () => Promise<Uint8Array> = () => Promise.reject(new Error("no build file asked for"));
  const theFileUploads = (): TakeUploads => (fileUploads ??= createTakeUploads({ bytes: () => nextFile(), seconds: () => 0 }, BUILD_FILE_UPLOAD_FIRST_ID));

  return {
    channel: AUDIO_TOPIC_CHANNEL,
    subscribe(params): DebugSubscription | { refused: string } {
      const p = readAudioSubscription(params);
      if ("refused" in p) return p;
      if (p.kind === "capture") return captureSubscription(captureLiveHost);
      if (p.kind === "take") return takeStateSubscription(takeState, takeOwnership);
      if (p.kind === "takeLive") return takeLiveSubscription(takeLive);
      return p.upload >= BUILD_FILE_UPLOAD_FIRST_ID ? theFileUploads().subscribe(p.upload) : theUploads().subscribe(p.upload);
    },
    async request(method, params) {
      switch (method) {
        case AudioRequest.start:
          await takeOwnership.startForTool(); // through the F10 trigger when installed: the same toasts
          return takeState();
        case AudioRequest.stop:
          takeOwnership.stopForTool();
          return takeState();
        case AudioRequest.mark: {
          const text = params && typeof params === "object" ? (params as Record<string, unknown>).text : undefined;
          if (typeof text !== "string") throw new Error("take.mark needs the marker's text");
          audioTake.mark(text);
          return takeState();
        }
        case AudioRequest.frames: {
          const width = params && typeof params === "object" ? (params as Record<string, unknown>).width : undefined;
          const refused = setTakeFrameWidth(width);
          if (refused !== null) throw new Error(`take.frames: ${refused}`);
          const reply: TakeFramesReply = { width: takeFrameWidth() };
          return reply;
        }
        case AudioRequest.upload:
          return theUploads().begin((params && typeof params === "object" ? params : {}) as TakeUploadParams);
        case AudioRequest.buildAudio:
          nextFile = () => buildAudioIndexBytes();
          return theFileUploads().begin({});
        case AudioRequest.buildFile:
          nextFile = () => buildFileBytes(params);
          return theFileUploads().begin(params);
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
      fileUploads?.dispose();
      fileUploads = null;
    },
  };
}
