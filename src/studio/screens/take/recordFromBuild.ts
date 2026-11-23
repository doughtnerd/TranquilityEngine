// Recording a take from a connected build (ADR 0348 takes, ADR 0380, plan U5): the Take screen's Start, Mark, Stop and
// Save drive the build's `audio` topic (schema in `plugins/audio/runtime/debugLink/schema.ts`): `take.start`,
// `take.mark` `{ text }` and `take.stop` run `Audio.take` on the build; Save asks `take.upload`, subscribes to the upload,
// reassembles its 64 KiB chunks with `createTakeReceiver` and writes the take file into the project's `takes/` folder
// through the Studio's import (`importFiles`, as Open take file… does; never over a file), named from the build and the
// time (`smoke-game_2026-11-22_10-15-00.mycotake`). Progress is the chunks received; any refusal, a broken upload or the
// link closing (`linkClosed`) fails with the message, and a take the build still holds can be saved again.
import { signal } from "@preact/signals";
import type { ConnectedBuild } from "../../../editor/debugLink/editorLink";
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import type { EditorProject } from "../../../editor/projects";
import { createTakeReceiver } from "../../../plugins/audio/editor/debugLink/takeReceiver";
import {
  AUDIO_TOPIC, AudioRequest, decodeTakeChunk, type AudioSubscriptionParams, type TakeMarkParams, type TakeStateReply, type TakeUploadReply,
} from "../../../plugins/audio/runtime/debugLink/schema";
import { TAKES_FOLDER } from "./takeFiles";

/** The build a take is recorded from: its name and its link (`studioBuild`'s `ConnectedBuild`). */
export type TakeBuild = Pick<ConnectedBuild, "name" | "peer">;

export type BuildTakeState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  /** The build records; `marks` placed so far. */
  | { readonly kind: "recording"; readonly marks: number }
  | { readonly kind: "stopping" }
  /** The build holds a stopped take of `seconds`, ready to save. */
  | { readonly kind: "stopped"; readonly seconds: number }
  /** Save: `received` of `chunks` chunks (`bytes` of `total` bytes) have arrived. */
  | { readonly kind: "uploading"; readonly received: number; readonly chunks: number; readonly bytes: number; readonly total: number }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly path: string }
  /** Something failed; `canSave` when the build may still hold a take to save again. */
  | { readonly kind: "failed"; readonly message: string; readonly canSave: boolean };

export interface BuildTakeSeams {
  /** Writes the take file `name` into the project; resolves with the path written (`saveTakeIntoProject`). */
  write(name: string, bytes: Uint8Array): Promise<string>;
  /** The time the take's name carries (default: now). */
  now?(): Date;
  /** The saved take was written (the Take screen opens it). */
  saved?(path: string): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const two = (n: number) => String(n).padStart(2, "0");

/** A take file's name from the build's name and `when`: `smoke-game_2026-11-22_10-15-00.mycotake`. */
export function buildTakeName(build: string, when: Date): string {
  const slug = build.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "build";
  const day = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
  const time = `${two(when.getHours())}-${two(when.getMinutes())}-${two(when.getSeconds())}`;
  return `${slug}_${day}_${time}.mycotake`;
}

/** Writes take bytes into `project`'s `takes/` folder as `name` (numbered if taken, never over a file); resolves with the path. */
export async function saveTakeIntoProject(project: EditorProject | null, name: string, bytes: Uint8Array): Promise<string> {
  const refused = whyNotImportable(project);
  if (refused || !project) throw new Error(refused ?? "no project is open");
  const r = await importFiles(project, TAKES_FOLDER, [{ path: name, read: async () => bytes }]);
  if (r.imported.length === 0) throw new Error(r.failed[0]?.error ?? `couldn't write ${TAKES_FOLDER}/${name}`);
  return r.imported[0]!;
}

/** The Take screen's recorder of one connected build's takes. */
export class BuildTakeRecorder {
  readonly state = signal<BuildTakeState>({ kind: "idle" });
  /** Ends a running upload with a message (the link closed). */
  private abortUpload: ((message: string) => void) | null = null;
  private gone: string | null = null;
  /** The build holds a take (recorded, or stopped and not yet replaced). */
  private holds = false;

  constructor(
    readonly build: TakeBuild,
    private readonly seams: BuildTakeSeams,
  ) {}

  get busy(): boolean {
    const k = this.state.peek().kind;
    return k === "starting" || k === "stopping" || k === "uploading" || k === "saving";
  }

  /** Start: the build begins a take (a new one; an earlier unsaved take is replaced). */
  async start(): Promise<void> {
    if (this.busy || this.state.peek().kind === "recording") return;
    this.state.value = { kind: "starting" };
    try {
      const r = await this.ask<TakeStateReply>(AudioRequest.start);
      this.holds = true;
      this.state.value = r.state === "recording" ? { kind: "recording", marks: 0 } : { kind: "failed", message: `${this.build.name} didn't start recording (its take is ${r.state}).`, canSave: false };
    } catch (e) {
      this.fail(`Couldn't start a take on ${this.build.name}: ${messageOf(e)}`);
    }
  }

  /** Mark: a marker with `text` at the build's present moment of the take. */
  async mark(text: string): Promise<void> {
    const s = this.state.peek();
    if (s.kind !== "recording") return;
    const params: TakeMarkParams = { text };
    try {
      await this.ask<TakeStateReply>(AudioRequest.mark, params);
      const now = this.state.peek();
      if (now.kind === "recording") this.state.value = { kind: "recording", marks: now.marks + 1 };
    } catch (e) {
      this.fail(`Couldn't mark the take: ${messageOf(e)}`);
    }
  }

  /** Stop: the build ends the take and keeps it for Save. */
  async stop(): Promise<void> {
    if (this.state.peek().kind !== "recording") return;
    this.state.value = { kind: "stopping" };
    try {
      const r = await this.ask<TakeStateReply>(AudioRequest.stop);
      this.state.value = { kind: "stopped", seconds: r.seconds };
    } catch (e) {
      this.fail(`Couldn't stop the take: ${messageOf(e)}`);
    }
  }

  /** Save: upload the build's take (stopping it if it still records) and write it into the project's takes folder. */
  async save(): Promise<string | null> {
    if (this.busy) return null;
    try {
      const reply = await this.ask<TakeUploadReply>(AudioRequest.upload, {});
      const bytes = await this.receive(reply);
      this.state.value = { kind: "saving" };
      const path = await this.seams.write(buildTakeName(this.build.name, this.seams.now?.() ?? new Date()), bytes);
      this.state.value = { kind: "saved", path };
      this.seams.saved?.(path);
      return path;
    } catch (e) {
      this.fail(`Couldn't save the take from ${this.build.name}: ${messageOf(e)}`);
      return null;
    }
  }

  /** The link to the build closed: whatever runs fails with why. */
  linkClosed(reason?: string): void {
    this.gone = `the link to ${this.build.name} closed${reason ? ` (${reason})` : ""}`;
    this.holds = false;
    this.abortUpload?.(this.gone);
    const k = this.state.peek().kind;
    if (k !== "idle" && k !== "saved" && k !== "failed" && k !== "saving") this.state.value = { kind: "failed", message: `The take stopped: ${this.gone}.`, canSave: false };
  }

  /** Back to idle after a save or a failure. */
  dismiss(): void {
    if (!this.busy) this.state.value = { kind: "idle" };
  }

  private fail(message: string): void {
    this.state.value = { kind: "failed", message, canSave: this.holds && this.gone === null };
  }

  private async ask<T>(method: string, params?: unknown): Promise<T> {
    if (this.gone) throw new Error(this.gone);
    return (await this.build.peer.request(AUDIO_TOPIC, method, params)) as T;
  }

  /** The upload's chunks, in order, reassembled; progress in `state`. */
  private receive(reply: TakeUploadReply): Promise<Uint8Array> {
    const rx = createTakeReceiver(reply);
    let received = 0;
    this.state.value = { kind: "uploading", received: 0, chunks: reply.chunks, bytes: 0, total: reply.bytes };
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (error: string | null, bytes?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        this.abortUpload = null;
        sub.unsubscribe();
        if (error === null) resolve(bytes!);
        else reject(new Error(error));
      };
      this.abortUpload = (message) => finish(message);
      const params: AudioSubscriptionParams = { kind: "upload", upload: reply.upload };
      const sub = this.build.peer.subscribe(
        AUDIO_TOPIC,
        params,
        (records) => {
          for (const r of records) {
            if (settled) return;
            const chunk = decodeTakeChunk(r.payload);
            if ("refused" in chunk) return finish(chunk.refused);
            const step = rx.push(chunk);
            if (step.status === "error") return finish(step.error);
            received++;
            if (step.status === "done") return finish(null, step.bytes);
            this.state.value = { kind: "uploading", received, chunks: reply.chunks, bytes: step.received, total: reply.bytes };
          }
        },
        (message) => finish(message),
      );
      if (this.gone) finish(this.gone);
    });
  }
}

/** What the Take screen says of a build's take (null: nothing). */
export function buildTakeStatus(state: BuildTakeState, build: string): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "starting":
      return `Starting a take on ${build}…`;
    case "recording":
      return `● Recording on ${build}${state.marks ? ` · ${state.marks} mark${state.marks === 1 ? "" : "s"}` : ""}`;
    case "stopping":
      return `Stopping the take on ${build}…`;
    case "stopped":
      return `Take stopped on ${build} · ${state.seconds.toFixed(1)} s · save it into ${TAKES_FOLDER}/`;
    case "uploading":
      return `Uploading the take · ${state.received} of ${state.chunks} chunk${state.chunks === 1 ? "" : "s"}`;
    case "saving":
      return "Saving the take…";
    case "saved":
      return `Saved ${state.path}`;
    case "failed":
      return state.message;
  }
}
