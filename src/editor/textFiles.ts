// The open project's text files as a CommandStack's file host (ADR 0026, 0077): commands that edit a
// file (a Svelte component's source) write through here, and undo and redo write back through here.
// Reads see each write at once; the file writes themselves (`project.writeFile`, which also updates
// what `Assets` serves) are queued per file and coalesced, so a drag that
// rewrites a file every frame costs at most one write in flight plus the latest text waiting.
//
// ADR 0423 wave C: Svelte UI code (a component, a rune module or a `.css` file components import) compiles with the
// project's scripts, so a write of one runs `onUICodeWritten`'s listener (the session reloads the project's code, and
// mounted views show the new version) before the file's queue moves on; `flush` waits for that too.
import { Assets } from "../engine/scene/Assets";
import { projectFileKind } from "../engine/scene/projectFiles";
import { isUISourcePath } from "../projectCode/uiModules";
import type { TextFileHost } from "./document";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, status } from "./state";

/** True for files that compile as Svelte UI code: components, rune modules and plain `.css`. */
const isUICode = (path: string): boolean => isUISourcePath(path) || path.endsWith(".css");

let afterUICodeWrite: (() => Promise<void>) | null = null;

/** Run `listener` after an edit writes Svelte UI code (the session reloads the project's code there). One listener; null removes it. */
export function onUICodeWritten(listener: (() => Promise<void>) | null): void {
  afterUICodeWrite = listener;
}

class ProjectTextFiles implements TextFileHost {
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
    return Assets.has(path) && projectFileKind(path) === "text" ? Assets.text(path) : null;
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
        if (isUICode(path) && afterUICodeWrite && (!this.pending.has(path) || this.pending.get(path) === text)) {
          try {
            await afterUICodeWrite();
          } catch (err) {
            this.report(`Couldn't reload the UI code after saving ${path}`, err);
          }
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
