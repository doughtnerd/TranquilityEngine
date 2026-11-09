// A project section (ADR 0151): a set of top-level keys of `project.json` being edited by one panel
// (Project Settings: everything but `bootstrap`; Worlds: `bootstrap`). It holds the draft and its
// undo history, keeps them when another panel's keys change, tells its own write coming back from an
// outside edit, writes valid drafts only (through the shared queue, so panels never drop each other's
// change), runs after-save and after-undo hooks, and exposes the history as an `UndoHistory` (ADR 0145).
// Panels are views over it: they read `open(project)` and call `edit`, `undo` and `redo`.
import { signal, type ReadonlySignal } from "@preact/signals";
import type { UndoHistory } from "./activeHistory";
import { errorStatus } from "./messages";
import { PROJECT_FILE, queueProjectFileWrite } from "./projectFile";
import type { EditorProject } from "./projects";
import { status } from "./state";
import { EditHistory, withMember } from "./worldsConfig";

/** Top-level `project.json` values by key. */
export type SectionValues = Readonly<Record<string, unknown>>;

/** What a section is: its keys, how its draft is read and written, what stops a save, and its hooks. */
export interface ProjectSectionSpec<D> {
  /** Its history's name ("Project Settings", "Worlds"). */
  readonly name: string;
  /** What save errors call it: "Couldn't save {what} to project.json". */
  readonly what: string;
  /** The keys it owns, asked each time: a plugin's settings section adds keys while the plugin is on. */
  keys(): readonly string[];
  /** The draft for the owned keys' values (a deep copy; absent keys are missing). */
  read(values: SectionValues): D;
  /** Each owned key's value in `draft`; undefined removes the key. Keys it doesn't own are ignored. */
  write(draft: D): SectionValues;
  /** Anything in the list keeps the draft unsaved, in the panel, until an edit or undo fixes it. */
  problems(draft: D, project: EditorProject): readonly unknown[];
  /** The draft with keys added since it was read (`added`: their values in the file). Without it, added keys start the section again. */
  adopt?(draft: D, added: SectionValues): D;
  /** After `draft` was written; `before` is what the file held. */
  saved?(project: EditorProject, draft: D, before: D): void;
  /** After an undo or redo moved the draft from `before` to `after` (whether or not it could be written). */
  stepped?(project: EditorProject, before: D, after: D): void;
}

/** The section's state for one open project. */
export interface ProjectSectionSession<D> {
  readonly project: EditorProject;
  readonly draft: D;
  /** A write is in progress. */
  readonly saving: boolean;
  /** The last write's failure, until a write succeeds. */
  readonly error: string | null;
  /** Whether the draft's keys differ from the file's (an invalid draft, or a save not done yet). */
  readonly unsaved: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  /** Make an edit: one undo step named `label`, saved if valid. No-op when read-only or nothing changes. Resolves once written (or skipped). */
  edit(label: string, next: D): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface ProjectSection<D> {
  /** Bumped when the session changes, so views re-render. */
  readonly version: ReadonlySignal<number>;
  /** The session for `project`, reconciled with `project.json`: read again only when the section's own keys changed elsewhere. */
  open(project: EditorProject): ProjectSectionSession<D>;
  /** The open session's undo list, for `usePanelHistory` (ADR 0145): Ctrl+Z and Edit > Undo step it. */
  readonly history: UndoHistory;
  /** Re-render the views (a field put back after a cancelled edit). */
  refresh(): void;
  /** Forget the session; the next `open` reads the file again. */
  reset(): void;
}

const json = (v: unknown) => JSON.stringify(v) ?? "";

function pick(settings: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out;
}

/** Each key's value as JSON, to tell a change to these keys from a change to others. */
const snapshot = (settings: unknown, keys: readonly string[]) => new Map(keys.map((k) => [k, json((settings as Record<string, unknown>)[k])]));

class Session<D> implements ProjectSectionSession<D> {
  /** `project.json`'s text when the section last read or wrote it. */
  fileText: string | undefined;
  /** The text a write in progress is writing: until it's done, the project may already hold it. */
  writingText: string | undefined;
  /** The owned keys when last read or written, with their values (JSON). */
  saved: Map<string, string>;
  keys: readonly string[];
  readonly history: EditHistory<D>;
  saving = false;
  error: string | null = null;

  constructor(
    private readonly owner: SectionImpl<D>,
    readonly project: EditorProject,
  ) {
    const spec = owner.spec;
    this.keys = spec.keys();
    this.fileText = project.textOf(PROJECT_FILE);
    this.saved = snapshot(project.settings, this.keys);
    this.history = new EditHistory(spec.read(pick(project.settings, this.keys)));
  }

  get draft(): D {
    return this.history.current;
  }
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }
  get undoLabel(): string | null {
    return this.history.undoLabel;
  }
  get redoLabel(): string | null {
    return this.history.redoLabel;
  }

  get unsaved(): boolean {
    const out = this.owner.spec.write(this.draft);
    const settings = this.project.settings as Record<string, unknown>;
    return this.owner.spec.keys().some((k) => json(out[k]) !== json(settings[k]));
  }

  /** Whether `a` and `b` write the same values. */
  private same(a: D, b: D): boolean {
    const spec = this.owner.spec;
    const x = spec.write(a), y = spec.write(b);
    return spec.keys().every((k) => json(x[k]) === json(y[k]));
  }

  edit(label: string, next: D): Promise<void> {
    if (!this.project.canSave || this.same(next, this.draft)) return Promise.resolve();
    this.history.push(label, next);
    this.owner.bump();
    return this.persist();
  }

  undo(): Promise<void> {
    return this.step(false);
  }

  redo(): Promise<void> {
    return this.step(true);
  }

  private step(redo: boolean): Promise<void> {
    const before = this.draft;
    if (!(redo ? this.history.redo() : this.history.undo())) return Promise.resolve();
    this.owner.bump();
    const written = this.persist();
    this.owner.spec.stepped?.(this.project, before, this.draft);
    return written;
  }

  /** Write the current draft if it's valid and differs from the file. Writes run one at a time and write the latest draft. */
  private persist(): Promise<void> {
    return queueProjectFileWrite(async () => {
      const spec = this.owner.spec;
      if (this.owner.session !== this || !this.project.canSave) return;
      const draft = this.draft;
      if (spec.problems(draft, this.project).length > 0) return;
      const keys = spec.keys();
      const out = spec.write(draft);
      const settings = this.project.settings as Record<string, unknown>;
      const changed = keys.filter((k) => json(out[k]) !== json(settings[k]));
      if (changed.length === 0) return;
      let text = this.project.textOf(PROJECT_FILE) ?? "{}\n";
      for (const key of changed) text = withMember(text, key, out[key]);
      const before = spec.read(pick(settings, keys));
      this.saving = true;
      this.writingText = text; // a render mid-save sees either text, and mustn't take its own save for an outside change
      this.owner.bump();
      try {
        await this.project.writeText(PROJECT_FILE, text);
        this.fileText = text;
        this.keys = keys;
        this.saved = snapshot(this.project.settings, keys);
        this.error = null;
        spec.saved?.(this.project, draft, before);
      } catch (err) {
        const failure = errorStatus(`Couldn't save ${spec.what} to ${PROJECT_FILE}`, err);
        this.error = failure.text;
        status.value = failure;
      } finally {
        this.writingText = undefined;
        this.saving = false;
        this.owner.bump();
      }
    });
  }

  /** Bring the session in line with the project: false when it must start again. */
  reconcile(): boolean {
    const spec = this.owner.spec;
    const settings = this.project.settings as Record<string, unknown>;
    const keys = spec.keys();
    if (json(keys) !== json(this.keys)) {
      const added = keys.filter((k) => !this.keys.includes(k));
      if (added.length > 0) {
        if (!spec.adopt) return false;
        const values: Record<string, unknown> = {};
        for (const k of added) values[k] = settings[k] === undefined ? undefined : structuredClone(settings[k]);
        this.history.map((d) => spec.adopt!(d, values)); // undo never removes a key the section didn't own
      }
      const saved = new Map<string, string>();
      for (const k of keys) saved.set(k, this.saved.get(k) ?? json(settings[k]));
      this.saved = saved;
      this.keys = keys;
    }
    const text = this.project.textOf(PROJECT_FILE);
    if (this.fileText === text || (this.writingText !== undefined && this.writingText === text)) return true;
    // Another panel's key changed (its save, or the Code panel editing other keys): keep the draft and its undo.
    if (this.writingText === undefined && keys.every((k) => this.saved.get(k) === json(settings[k]))) {
      this.fileText = text;
      return true;
    }
    return false;
  }
}

class SectionImpl<D> implements ProjectSection<D> {
  session: Session<D> | null = null;
  private readonly count = signal(0);
  readonly version: ReadonlySignal<number> = this.count;
  readonly history: UndoHistory;

  constructor(readonly spec: ProjectSectionSpec<D>) {
    const self = this;
    this.history = {
      name: spec.name,
      get canUndo() {
        return (self.count.value, !!self.session?.project.canSave && self.session.canUndo);
      },
      get canRedo() {
        return (self.count.value, !!self.session?.project.canSave && self.session.canRedo);
      },
      get undoLabel() {
        return (self.count.value, self.session?.undoLabel ?? null);
      },
      get redoLabel() {
        return (self.count.value, self.session?.redoLabel ?? null);
      },
      undo: () => void self.session?.undo(),
      redo: () => void self.session?.redo(),
    };
  }

  bump(): void {
    this.count.value++;
  }

  open(project: EditorProject): ProjectSectionSession<D> {
    const s = this.session;
    if (s && s.project === project && s.reconcile()) return s;
    return (this.session = new Session(this, project));
  }

  /** Bound, so views can pass it on as a callback. */
  readonly refresh = (): void => this.bump();

  reset(): void {
    this.session = null;
    this.bump();
  }
}

/** A project section over `spec`: kept outside any component, since a hidden tab unmounts. */
export function createProjectSection<D>(spec: ProjectSectionSpec<D>): ProjectSection<D> {
  return new SectionImpl(spec);
}
