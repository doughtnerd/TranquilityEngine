// The Mixer screen's session (ADR 0344, 0341): the `audio.json` document every panel edits, the screen's UI state
// (selection, the snapshot being edited, the view, folds, test values, the live board's pins), and the actions that
// need more than one pure edit (a confirm before a delete, a rename that also rewrites the playlists and scenes naming
// a bus, an undo toast after a snapshot delete). Every edit is one labelled undo step of the document; a refused edit
// says why in the status bar. While the Studio's runtime runs, the document's changes reach it through `LiveMix`.
//
// Panels take the session as a prop, so stories give them one over a plain signal (`createMixerSession` with injected
// deps); the screen's `index.tsx` makes the real one over the open project.
import { computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { AudioProject } from "../../../engine/audio/project/types";
import { addBus, addReturn, addVca, deleteItem, kindOf, masterOf, planDelete, renameItem, type EditResult } from "./busTree";
import { createLiveMix, type LiveMix, type LiveMixHost, type LiveOrigin } from "./liveMix";
import { labelOn } from "./mixEdits";
import type { RemoteMix } from "./remoteMix";
import { DEFAULT_PINS, livePins, togglePin, type BusReading, type LoudnessReading } from "./boardModel";
import { addFolder, deleteSnapshot, newSnapshot } from "./snapshotTree";
import type { TestValues } from "./snapshotBlend";

/** What the session edits: the `audio.json` document (an `AssetDocument`), or a story's stand-in. */
export interface MixDocument {
  readonly value: ReadonlySignal<AudioProject>;
  readonly readOnly: boolean;
  edit(next: AudioProject, options?: { label?: string; coalesce?: boolean }): void;
  /**
   * The document's history tree (the engine's undo history, ADR 0341: the authority): where it stands and its states,
   * so a change the session didn't make is told apart as an undo or a redo. Absent (a story): such changes are edits.
   */
  readonly history?: { readonly current: number; readonly states: readonly unknown[] };
  /** Undo the last step, and its name (absent: a story without a history; a new snapshot is then deleted instead). */
  undo?(): void;
  readonly undoLabel?: ReadonlySignal<string | null>;
}

/** Where the session reaches the world: confirm dialogs, toasts, the status bar, other files, the runtime. */
export interface MixerDeps {
  readonly doc: MixDocument;
  /** The document's path, for `data-asset-document` (the History panel and Ctrl+Z follow it). */
  readonly path?: string;
  confirm(question: { title: string; message: string; items?: string[]; confirmLabel: string; danger?: boolean }): Promise<boolean>;
  toast(request: { text: string; undo?: () => void }): void;
  /** A refusal or a note for the status bar. */
  report(kind: "error" | "info", text: string): void;
  /** Files outside `audio.json` that name `name` (playlists, events, scenes). */
  usersOf?(name: string): string[];
  /** Rewrite those files for a rename; resolves to the files changed. */
  renameOutside?(from: string, to: string): Promise<string[]>;
  /** The runtime, when there is one. */
  readonly live?: LiveMixHost;
  /** A connected build's mix (U8): each edit is also sent to it (`remoteMix.ts`). Absent, or with no build: nothing is sent. */
  readonly remote?: RemoteMix;
  readBus?(name: string): BusReading | null;
  /** A bus as the open take recorded it at the replay's playhead (`recordedLevels.ts`); null when the take's profile can't say. */
  recordedBus?(name: string): BusReading | null;
  readLoudness?(name: string): LoudnessReading | null;
  setParameter?(name: string, value: number | string): void;
  auditionSnapshot?(name: string | null, fadeSeconds: number): void;
  /** The loudness target the meters check against (`Audio.loudnessTarget`). */
  setLoudnessTarget?(name: string): void;
  /** Reset the loudness meters (a whole take's measurement starts from its first second). */
  resetLoudness?(): void;
  /** MX-63: the open take's replay (its path, length, playhead and whether it plays), null with none. Subscribes in a render. */
  takeReplay?(): { readonly take: string; readonly duration: number; readonly time: number; readonly playing: boolean } | null;
  /**
   * The game session is live (the player bar's session: the open take's replay until the live game link, owner
   * decision UI pass #1). Read inside a render, it should subscribe (a signal's value). Absent: never live.
   */
  sessionLive?(): boolean;
  /** Open a project file in its screen (a playlist from the Inspector's Used by). */
  openFile?(path: string): void;
  /** Per-user preferences (pins, the board's fold, the view); a story passes plain signals. */
  readonly prefs?: { pins: Signal<string[]>; boardOpen: Signal<boolean>; view: Signal<"list" | "strips"> };
}

export interface MixerSession {
  readonly deps: MixerDeps;
  readonly project: ReadonlySignal<AudioProject>;
  readonly readOnly: boolean;
  /** The bus, return or VCA selected (falls back to Master). */
  readonly selected: ReadonlySignal<string>;
  /** The snapshot whose mix is edited (null: the base mix). */
  readonly editing: Signal<string | null>;
  readonly view: Signal<"list" | "strips">;
  readonly collapsed: Signal<ReadonlySet<string>>;
  readonly testValues: Signal<TestValues>;
  readonly pins: ReadonlySignal<string[]>;
  readonly boardOpen: Signal<boolean>;
  /** Edits made while the game session was live, kept after it stops ("3 edits kept"); 0 again when it next starts. */
  readonly liveEdits: ReadonlySignal<number>;
  /** The game session is live now (read in a render, it subscribes); its start sets `liveEdits` back to 0. */
  sessionLive(): boolean;
  /** The take replay is paused part-way: meters and loudness readouts hold the levels they had when it paused. */
  levelsHeld(): boolean;
  /** Bumped while the runtime runs, so meters re-read. */
  readonly tick: Signal<number>;
  readonly live: LiveMix | null;
  /** Mirrors the monitor's solo (one at a time). */
  readonly soloed: Signal<string | null>;
  select(name: string): void;
  /** Apply an edit as one undo step (`coalesce` for drags); a refusal goes to the status bar. Returns whether it applied. */
  commit(result: EditResult<AudioProject>, label: string, coalesce?: boolean): boolean;
  refuse(label: string, reason: string): void;
  /** A new bus inside the selected one (selected after); its name, or null when refused. */
  newBus(): string | null;
  newReturn(): string | null;
  newVca(): string | null;
  rename(from: string, to: string): Promise<boolean>;
  remove(name: string): Promise<boolean>;
  newSnapshot(folder: string): string | null;
  /**
   * Escape while a just-made snapshot's name is typed: it never happened (its "New snapshot" step is undone; without a
   * history it's deleted).
   */
  cancelNewSnapshot(name: string): void;
  /** A new empty snapshot folder under `parent` ("New folder"); its path, or null when refused. */
  newFolder(parent: string): string | null;
  removeSnapshot(name: string): void;
  editSnapshot(name: string | null): void;
  setTestValue(name: string, value: number | null): void;
  togglePin(name: string): void;
  toggleSolo(name: string): void;
  dispose(): void;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function createMixerSession(deps: MixerDeps): MixerSession {
  const doc = deps.doc;
  const project = computed(() => doc.value.value);
  const chosen = signal<string | null>(null);
  const selected = computed(() => {
    const p = project.value;
    const c = chosen.value;
    return c !== null && kindOf(p, c) ? c : masterOf(p);
  });
  const editing = signal<string | null>(null);
  const prefs = deps.prefs ?? { pins: signal<string[]>([...DEFAULT_PINS]), boardOpen: signal(false), view: signal<"list" | "strips">("list") };
  const pins = computed(() => livePins(prefs.pins.value, project.value));
  const soloed = signal<string | null>(null);
  const liveEdits = signal(0);
  let sessionWasLive = false;
  /** Whether the session is live now; a new start counts edits from 0 again. */
  const sessionNow = (): boolean => {
    const on = session.deps.sessionLive?.() ?? false;
    if (on && !sessionWasLive) liveEdits.value = 0;
    sessionWasLive = on;
    return on;
  };
  // A take replay paused part-way holds its levels: readings taken while it plays are kept, and handed back until it
  // plays again (stopped at the start or end, or no take open, the readings fall to what the runtime reports).
  const levelsHeld = (): boolean => {
    const r = deps.takeReplay?.() ?? null;
    return !!r && !r.playing && r.time > 0 && r.time < r.duration;
  };
  // A paused replay shows what the take recorded at the playhead where its profile has it, so a scrub moves the meters.
  const paused = (): boolean => {
    const r = deps.takeReplay?.() ?? null;
    return !!r && !r.playing;
  };
  const holding = <T,>(read: ((name: string) => T | null) | undefined, recorded?: (name: string) => T | null): ((name: string) => T | null) | undefined => {
    if (!read) return undefined;
    const last = new Map<string, T | null>();
    return (name) => {
      if (recorded && paused()) {
        const then = recorded(name);
        if (then !== null) return then;
      }
      if (levelsHeld() && last.has(name)) return last.get(name)!;
      const now = read(name);
      last.set(name, now);
      return now;
    };
  };
  const live = deps.live ? createLiveMix(deps.live, () => doc.value.peek()) : null;
  const stops: (() => void)[] = [];
  // With a build connected (`studioBuild`), every change of the document is also sent to it as `mix.op` commands; the
  // Studio's own runtime below still gets it, and a refusal from the build shows in the status bar (`deps.report`).
  if (deps.remote) {
    const remote = deps.remote;
    let sentFrom = doc.value.peek();
    stops.push(
      effect(() => {
        const after = doc.value.value;
        const prev = sentFrom;
        sentFrom = after;
        if (prev !== after) remote.changed(prev, after);
      }),
      () => remote.dispose(),
    );
  }

  // Every change of the document (an edit, undo, redo, an outside write) reaches the running mixer, named by who made
  // it: the session's own edits (a drag's coalesced moves too, one step of the history) are the editor's; a change the
  // session didn't make is read against the document's history tree: back to an older state is an undo, on to a newer
  // one a redo (a drag's burst that undo first closes as its step counts too), anything else an outside change.
  let ownEdit = false;
  const history = doc.history;
  let at = history ? { current: history.current, states: history.states.length } : null;
  const originOf = (): LiveOrigin => {
    if (!history || !at) return "editor";
    const was = at;
    at = { current: history.current, states: history.states.length };
    if (ownEdit) return "editor";
    if (at.current < was.current || (at.current === was.current && at.states > was.states)) return "undo";
    if (at.current > was.current) return "redo";
    return "editor";
  };
  if (live) {
    let before = doc.value.peek();
    let wasRunning = deps.live!.running();
    if (wasRunning) live.started(before);
    stops.push(
      effect(() => {
        const after = doc.value.value;
        const prev = before;
        before = after;
        if (prev === after) return;
        const entry = live.changed(prev, after, originOf());
        if (entry && entry.failed > 0) deps.report("info", `${entry.failed} change${entry.failed === 1 ? "" : "s"} will be heard the next time the Studio's audio starts.`);
      }),
    );
    const timer = setInterval(() => {
      const running = deps.live!.running();
      if (running !== wasRunning) {
        wasRunning = running;
        if (running) live.started(doc.value.peek());
        else {
          live.stopped();
          soloed.value = null;
        }
      }
      if (running) session.tick.value++;
    }, 100);
    stops.push(() => clearInterval(timer));
  }
  // An edited snapshot that's gone (deleted, undone) falls back to the base mix.
  stops.push(effect(() => { const e = editing.value; if (e !== null && !project.value.snapshots.some((s) => s.name === e)) editing.value = null; }));

  let lastCoalesced: string | null = null;
  const refuse = (label: string, reason: string) => deps.report("error", `Can't ${lowerFirst(label)}: ${reason}`);
  const commit = (result: EditResult<AudioProject>, label: string, coalesce = false): boolean => {
    if ("refused" in result) return refuse(label, result.refused), false;
    if (live?.locked) return refuse(label, "Compare is playing A; switch back to B to edit"), false;
    if (result.next === doc.value.peek()) return true;
    ownEdit = true;
    try {
      doc.edit(result.next, { label, coalesce });
    } finally {
      ownEdit = false;
    }
    // A drag's moves are one edit: count its first move only.
    if (sessionNow() && !(coalesce && lastCoalesced === label)) liveEdits.value++;
    lastCoalesced = coalesce ? label : null;
    return true;
  };

  const session: MixerSession = {
    deps: Object.assign(Object.create(deps) as MixerDeps, { readBus: holding(deps.readBus, deps.recordedBus?.bind(deps)), readLoudness: holding(deps.readLoudness) }),
    levelsHeld,
    project,
    readOnly: doc.readOnly,
    selected,
    editing,
    view: prefs.view,
    collapsed: signal<ReadonlySet<string>>(new Set()),
    testValues: signal<TestValues>({}),
    pins,
    boardOpen: prefs.boardOpen,
    liveEdits,
    sessionLive: sessionNow,
    tick: signal(0),
    live,
    soloed,
    select: (name) => void (chosen.value = name),
    commit,
    refuse,
    newBus() {
      const r = addBus(project.peek(), selected.peek());
      if ("refused" in r) return refuse("New bus", r.refused), null;
      if (!commit({ next: r.next.project }, "New bus")) return null;
      chosen.value = r.next.name;
      return r.next.name;
    },
    newReturn() {
      const r = addReturn(project.peek());
      if ("refused" in r) return refuse("New return", r.refused), null;
      if (!commit({ next: r.next.project }, "New return")) return null;
      chosen.value = r.next.name;
      return r.next.name;
    },
    newVca() {
      const r = addVca(project.peek());
      if ("refused" in r) return refuse("New VCA", r.refused), null;
      if (!commit({ next: r.next.project }, "New VCA")) return null;
      chosen.value = r.next.name;
      return r.next.name;
    },
    async rename(from, to) {
      const label = labelOn("Rename", from);
      const r = renameItem(project.peek(), from, to);
      if ("refused" in r) return refuse(label, r.refused), false;
      if (r.next === project.peek()) return true;
      const users = kindOf(project.peek(), from) === "vca" ? [] : (deps.usersOf?.(from) ?? []);
      if (users.length > 0) {
        const ok = await deps.confirm({
          title: "Rename",
          message: `Rename "${from}" to "${to}"? ${users.length === 1 ? "A file routes to it; it will be updated." : `${users.length} files route to it; they will be updated.`}`,
          items: users.slice(0, 8).concat(users.length > 8 ? [`and ${users.length - 8} more`] : []),
          confirmLabel: "Rename and update",
          danger: false,
        });
        if (!ok) return false;
      }
      if (!commit(r, label)) return false;
      if (chosen.peek() === from) chosen.value = to;
      if (prefs.pins.peek().includes(from)) prefs.pins.value = prefs.pins.peek().map((n) => (n === from ? to : n));
      if (users.length > 0 && deps.renameOutside) {
        const changed = await deps.renameOutside(from, to);
        if (changed.length > 0) deps.report("info", `Renamed ${from} to ${to} in ${changed.length} file${changed.length === 1 ? "" : "s"}.`);
      }
      return true;
    },
    async remove(name) {
      const p = project.peek();
      const kind = kindOf(p, name);
      const label = labelOn(kind === "return" ? "Delete return" : kind === "vca" ? "Delete VCA" : "Delete bus", name);
      const plan = planDelete(p, name);
      if ("refused" in plan) return refuse(label, plan.refused), false;
      const users = kind === "vca" ? [] : (deps.usersOf?.(name) ?? []);
      const items = [...plan.next.lines, ...(users.length > 0 ? [`${users.length} file${users.length === 1 ? "" : "s"} still route${users.length === 1 ? "s" : ""} here and will play through ${masterOf(p)}: ${users.slice(0, 4).join(", ")}${users.length > 4 ? "…" : ""}`] : [])];
      const ok = await deps.confirm({ title: `Delete ${name}?`, message: items.length > 0 ? "This goes with it (Undo brings it all back):" : "Nothing else uses it.", items, confirmLabel: "Delete" });
      if (!ok) return false;
      const applied = commit(deleteItem(project.peek(), name), label);
      if (applied && selected.peek() === name) chosen.value = plan.next.newParent;
      return applied;
    },
    newSnapshot(folder) {
      const r = newSnapshot(project.peek(), folder);
      if ("refused" in r) return refuse("New snapshot", r.refused), null;
      if (!commit({ next: r.next.project }, "New snapshot")) return null;
      editing.value = r.next.name;
      return r.next.name;
    },
    cancelNewSnapshot(name) {
      if (!project.peek().snapshots.some((s) => s.name === name)) return;
      if (doc.undo && doc.undoLabel?.peek() === "New snapshot") {
        doc.undo();
        return;
      }
      commit(deleteSnapshot(project.peek(), name), labelOn("Delete snapshot", name));
    },
    newFolder(parent) {
      const r = addFolder(project.peek(), parent);
      if ("refused" in r) return refuse("New folder", r.refused), null;
      return commit({ next: r.next.project }, "New folder") ? r.next.path : null;
    },
    removeSnapshot(name) {
      const label = labelOn("Delete snapshot", name);
      const before = project.peek();
      const at = before.snapshots.findIndex((s) => s.name === name);
      if (!commit(deleteSnapshot(before, name), label)) return;
      const gone = before.snapshots[at]!;
      // The toast's Undo puts it back where it was (a new step, so edits made since aren't undone with it).
      deps.toast({
        text: `Deleted ${name}`,
        undo: () => {
          const now = project.peek();
          if (now.snapshots.some((s) => s.name === name)) return refuse(labelOn("Restore snapshot", name), `another snapshot is named "${name}"`);
          const snapshots = [...now.snapshots];
          snapshots.splice(Math.min(at, snapshots.length), 0, gone);
          commit({ next: { ...now, snapshots } }, labelOn("Restore snapshot", name));
        },
      });
    },
    editSnapshot(name) {
      editing.value = name;
      const s = name === null ? null : project.peek().snapshots.find((x) => x.name === name);
      // Hear what you edit: a base-mix snapshot is the plain mix.
      deps.auditionSnapshot?.(s && s.start.kind !== "base" ? s.name : null, (s?.fadeInMs ?? 300) / 1000);
    },
    setTestValue(name, value) {
      const next = { ...session.testValues.peek() };
      if (value === null) delete next[name];
      else next[name] = value;
      session.testValues.value = next;
      const def = project.peek().parameters.find((p) => p.name === name);
      if (def && deps.setParameter) {
        if ("labels" in def) deps.setParameter(name, def.labels[Math.round(value ?? Math.max(0, def.labels.indexOf(def.default)))] ?? def.default);
        else deps.setParameter(name, value ?? def.default);
      }
    },
    togglePin(name) {
      const next = togglePin(pins.peek(), name);
      if (next === null) return deps.report("error", "The live board holds at most 8 buses; unpin one first.");
      prefs.pins.value = next;
    },
    toggleSolo(name) {
      if (!live) return deps.report("info", "Solo needs the Studio's audio running (audition a playlist).");
      const was = soloed.peek();
      if (was !== null) live.monitor.setSolo(was, false);
      if (was !== name) live.monitor.setSolo(name, true);
      soloed.value = was === name ? null : name;
    },
    dispose() {
      for (const s of stops) s();
      if (soloed.peek() !== null) live?.monitor.clearAll();
    },
  };
  return session;
}
