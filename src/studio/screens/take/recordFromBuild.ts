// Recording a take from a connected build (ADR 0348 takes, ADR 0403, plan U5): the Take screen's Start, Mark, Stop and
// Save drive the build's `audio` topic through the audio link client (ADR 0417, `plugins/audio/editor/debugLink/
// audioLinkClient.ts`): start, mark and stop run `Audio.take` on the build; Save uploads the take's bytes (the client
// reassembles the chunks and reports progress) and writes the take file into the project's `recordings/` folder
// through the Studio's import (`importFiles`, as Open take file… does; never over a file; a takes folder workspace's
// root, ADR 0408), named from the build and the
// time (`smoke-game_2026-11-22_10-15-00.sporesample`). Progress is the chunks received; any refusal, a broken upload or the
// link closing (`linkClosed`) fails with the message, and a take the build still holds can be saved again.
import { signal } from "@preact/signals";
import type { ConnectedBuild } from "../../../editor/debugLink/editorLink";
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import { isTakesFolder, type EditorProject } from "../../../editor/projects";
import { audioLinkClient, type AudioLinkClient } from "../../../plugins/audio/editor/debugLink/audioLinkClient";
import type { TakeStateReply } from "../../../plugins/audio/runtime/debugLink/schema";
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
  /**
   * The saved take was written (the Take screen opens it). `auto`: the build stopped the take and it was saved without
   * a press (ADR 0408), so nothing should take the user off their screen.
   */
  saved?(path: string, auto: boolean): void;
  /**
   * ADR 0408: save a take the build stops by itself (F10, its script) at once (default true). False where saving needs
   * the user's press (a browser's save dialog): the take then waits, stopped, for Save.
   */
  autoSave?(): boolean;
  /**
   * ADR 0411: the take pictures' width the user chose (the Connect dialog's), sent with `take.frames` right before each
   * `take.start`, so the take is recorded at it even if the send on connect or on change was missed. A build that doesn't
   * know the request keeps its own width. Absent: nothing is sent.
   */
  pictureWidth?(): number;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const two = (n: number) => String(n).padStart(2, "0");

/** A take file's name from the build's name and `when`: `smoke-game_2026-11-22_10-15-00.sporesample`. */
export function buildTakeName(build: string, when: Date): string {
  const slug = build.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "build";
  const day = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
  const time = `${two(when.getHours())}-${two(when.getMinutes())}-${two(when.getSeconds())}`;
  return `${slug}_${day}_${time}.sporesample`;
}

/** Where a take saved into `project` goes: its `recordings/` folder, or a takes folder workspace's own root (ADR 0408). */
export const takeSaveFolder = (project: EditorProject | null): string => (isTakesFolder(project) ? "" : TAKES_FOLDER);

/**
 * Writes take bytes into `project`'s `recordings/` folder (a takes folder workspace: its root) as `name` (numbered if taken,
 * never over a file); resolves with the path.
 */
export async function saveTakeIntoProject(project: EditorProject | null, name: string, bytes: Uint8Array): Promise<string> {
  const refused = whyNotImportable(project);
  if (refused || !project) throw new Error(refused ?? "no project is open");
  const folder = takeSaveFolder(project);
  const r = await importFiles(project, folder, [{ path: name, read: async () => bytes }]);
  if (r.imported.length === 0) throw new Error(r.failed[0]?.error ?? `couldn't write ${folder ? `${folder}/` : ""}${name}`);
  return r.imported[0]!;
}

/** The Take screen's recorder of one connected build's takes. */
export class BuildTakeRecorder {
  readonly state = signal<BuildTakeState>({ kind: "idle" });
  /** Ends a running upload with a message (the link closed). */
  private abortUpload: AbortController | null = null;
  private gone: string | null = null;
  /** The build holds a take (recorded, or stopped and not yet replaced). */
  private holds = false;
  /** The build's take state follow (ADR 0408): its take's state as it changes, however it changed; its stop. */
  private watching: (() => void) | null = null;

  constructor(
    readonly build: TakeBuild,
    private readonly seams: BuildTakeSeams,
    /** The build's audio link client (the build session shares its own). */
    private readonly client: AudioLinkClient = audioLinkClient(build.peer),
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
      const width = this.seams.pictureWidth?.();
      if (width !== undefined) await this.ask((c) => c.frames(width)).catch(() => {}); // an older build: its own width
      const r = await this.ask((c) => c.start());
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
    try {
      await this.ask((c) => c.mark(text));
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
      const r = await this.ask((c) => c.stop());
      this.state.value = { kind: "stopped", seconds: r.seconds };
    } catch (e) {
      this.fail(`Couldn't stop the take: ${messageOf(e)}`);
    }
  }

  /**
   * ADR 0408: follow the build's take as the build changes it (F10, its script): a take it starts shows as recording,
   * and one it stops is saved at once (`autoSave`), since the Studio, not the build, decides where takes go. While this
   * watches, the build's F10 saves nothing itself. A build too old for it refuses, and nothing changes.
   */
  watch(): void {
    if (this.watching || this.gone) return;
    this.watching = this.client.followTakeState(
      (t) => this.buildSays(t),
      () => (this.watching = null),
    );
  }

  /** Stop watching the build's take (the recorder is replaced or the Studio goes). */
  dispose(): void {
    this.watching?.();
    this.watching = null;
  }

  private buildSays(t: TakeStateReply): void {
    const k = this.state.peek().kind;
    if (t.state === "recording" && (k === "idle" || k === "stopped" || k === "saved" || k === "failed")) {
      this.holds = true;
      this.state.value = { kind: "recording", marks: 0 };
    } else if (t.state === "stopped" && k === "recording") {
      // The build stopped its take (a Studio Stop shows "stopping" first, so this is the game's).
      this.state.value = { kind: "stopped", seconds: t.seconds };
      if (this.seams.autoSave?.() ?? true) void this.save(true);
    }
  }

  /** Save: upload the build's take (stopping it if it still records) and write it into the project's takes folder. */
  async save(auto = false): Promise<string | null> {
    if (this.busy) return null;
    try {
      const bytes = await this.receive();
      this.state.value = { kind: "saving" };
      const path = await this.seams.write(buildTakeName(this.build.name, this.seams.now?.() ?? new Date()), bytes);
      this.state.value = { kind: "saved", path };
      this.seams.saved?.(path, auto);
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
    this.watching = null;
    this.abortUpload?.abort(this.gone);
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

  private async ask<T>(op: (client: AudioLinkClient) => Promise<T>): Promise<T> {
    if (this.gone) throw new Error(this.gone);
    return op(this.client);
  }

  /** The build's take, uploaded and reassembled by the client; progress in `state`. */
  private async receive(): Promise<Uint8Array> {
    if (this.gone) throw new Error(this.gone);
    const abort = (this.abortUpload = new AbortController());
    try {
      return await this.client.uploadTake({
        signal: abort.signal,
        onProgress: (p) => (this.state.value = { kind: "uploading", received: p.received, chunks: p.chunks, bytes: p.bytes, total: p.total }),
      });
    } finally {
      if (this.abortUpload === abort) this.abortUpload = null;
    }
  }
}

/** What the Take screen says of a build's take (null: nothing); `into` names where Save writes it. */
export function buildTakeStatus(state: BuildTakeState, build: string, into = `${TAKES_FOLDER}/`): string | null {
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
      return `Take stopped on ${build} · ${state.seconds.toFixed(1)} s · save it into ${into}`;
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
