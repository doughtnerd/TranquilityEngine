// The open project's text files as a CommandStack's file host (ADR 0026, 0077): commands that edit a
// UI document's markup or stylesheet write through here, and undo and redo write back through here.
// Reads see each write at once; the file writes themselves (`project.writeFile`, which also updates
// what `Assets` serves, so documents hot-reload) are queued per file and coalesced, so a drag that
// rewrites a file every frame costs at most one write in flight plus the latest text waiting.
import { Assets } from "../engine/scene/Assets";
import type { TextFileHost } from "./document";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, status } from "./state";

export class ProjectTextFiles implements TextFileHost {
  /** Text written but not yet on disk (null: being deleted), newest per file. */
  private readonly pending = new Map<string, string | null>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly project: () => EditorProject | null,
    private readonly report: (message: string, err?: unknown) => void,
  ) {}

  read(path: string): string | null {
    if (this.pending.has(path)) return this.pending.get(path)!;
    const project = this.project();
    const text = project?.textOf(path);
    if (text !== undefined) return text;
    if (project && !project.files.includes(path)) return null;
    const value = Assets.has(path) ? Assets.get(path) : undefined;
    return typeof value === "string" ? value : null;
  }

  write(path: string, text: string): void {
    this.queue(path, text);
  }

  remove(path: string): void {
    this.queue(path, null);
  }

  conflict(path: string, label: string): void {
    this.report(`${path} changed since "${label}", so it was left as it is.`);
  }

  /** True while writes are queued or running. */
  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Wait until every queued write has finished. */
  async flush(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private queue(path: string, value: string | null): void {
    const project = this.project();
    if (!project) throw new Error("No project is open.");
    if (!project.canSave) throw new Error(`${project.name} is read-only.`);
    this.pending.set(path, value);
    if (this.running.has(path)) return; // the running loop writes the newest text when it's done
    const loop = async () => {
      for (;;) {
        const text = this.pending.get(path)!;
        try {
          if (text === null) await project.deleteFile(path);
          else await project.writeFile(path, text);
        } catch (err) {
          this.report(`Couldn't save ${path}`, err);
        }
        if (!this.pending.has(path) || this.pending.get(path) === text) break;
      }
      this.pending.delete(path);
      this.running.delete(path);
    };
    this.running.set(path, loop());
  }
}

/** The editor's file host, on the current project: every open scene's stack writes through it. */
export const editorTextFiles = new ProjectTextFiles(
  () => currentProject.peek(),
  (message, err) => (status.value = err === undefined ? { kind: "error", text: message } : errorStatus(message, err)),
);
