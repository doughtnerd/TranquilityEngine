/**
 * The editor's view of the input system (ADR 0336, 0337), part of the editor SDK (`./index.ts` re-exports it):
 *
 * - `inputState(world)`: a play World's devices, players, each player's active contexts in priority order, its
 *   actions (value, phase flags, elapsed time, the mapping that gave the value), the controls higher-priority
 *   contexts consumed, and a rebind in progress: what the Input debugger panel shows. A copy; read-only.
 * - `watchInput(world)`: a log of the World's `ActionEvents`, `DeviceEvents`, `PlayerJoined`, `PlayerLeft` and
 *   `RebindResults`, recorded every frame (those buffers are cleared at the end of each frame, so a panel sampling a
 *   few times a second would miss them). While nothing watches, no system runs.
 * - What the context asset editor offers and checks: the defined action sets, the contexts registered in code, a
 *   control path's canonical form, and the problems the evaluator reports for a context.
 * - `watchRawPresses(callback)`: every press the Engine's device snapshot sees (keys, mouse buttons, gamepad buttons
 *   and stick directions from every gamepad adapter, touches, pen buttons), with or without a play World: the
 *   context editor's Bind.
 * - `recordInput()`: a hardware recording of the gamepad adapters' raw input (`input/recording.ts`), the Input
 *   debugger's Record.
 */
import type { World } from "../core/World";
import { _undefineBuiltinSystem, defineBuiltinSystem, type BuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { ActionEvents, ActionPhase, actionSetClashes, actionSetSource, actionSets, actionView, type ActionEventPhase, type ActionKind, type ActionPhaseName } from "../input/actions";
import { DEFAULT_CONTEXT, registeredContexts } from "../input/contexts";
import type { InputContextSpec, MappingSpec, ModifierSpec } from "../input/contextTypes";
import { compileModifier } from "../input/modifiers";
import { PRESS_POINT, control, namedControlPaths, type DeviceFamily } from "../input/controls";
import { DEVICE_FAMILIES, DeviceEvents, DeviceKind, InputDevice, deviceNodes, takesLocalInput } from "../input/deviceEntities";
import { DEFAULT_STICK_DEADZONE, contextProblems, lastEvaluation, playerTable, type CompiledMapping } from "../input/evaluate";
import { ControlledBy, InputPlayer, PlayerJoined, PlayerLeft, playerNodes } from "../input/players";
import { RebindResults, pendingRebind, type PendingRebind } from "../input/rebind";
import { Input } from "../input/Input";
import { KEYBOARD_DEVICE, PEN_DEVICE, POINTER_DEVICE, TOUCH_DEVICE, devices } from "../input/devices";
import { startInputRecording, type InputRecorder } from "../input/recording";

export type { PendingRebind } from "../input/rebind";
export { RECORDING_FORMAT, RECORDING_VERSION, parseInputRecording, type InputRecorder, type InputRecording, type RecordedHidDevice, type RecordedInputEvent, type RecordedWebPad } from "../input/recording";

// --- live state ----------------------------------------------------------------------------------

/** A device a World sees. */
export interface InputDeviceRow {
  /** The adapter's id: -1 keyboard, -2 pointer, gamepads from 0. */
  readonly id: number;
  readonly name: string;
  readonly kind: "keyboard" | "pointer" | "gamepad";
  readonly family: DeviceFamily;
  /** A gamepad's order of connection (0 first); 0 for the keyboard and pointer. */
  readonly slot: number;
  /** The paired player's index, -1 for none. */
  readonly player: number;
  readonly connected: boolean;
}

/** The mapping that gave an action its value this frame. */
export interface InputSourceRow {
  readonly context: string;
  /** Its index in the context's mappings. */
  readonly mapping: number;
  /** `single`, `dpad`, `axis` or `modifier` (a chord). */
  readonly composite: CompiledMapping["source"]["kind"];
  /** The control paths it reads. */
  readonly controls: readonly string[];
}

/** One action of a player, as its action set's row holds it now. */
export interface InputActionRow {
  readonly set: string;
  readonly action: string;
  readonly kind: ActionKind;
  /** One component for buttons and axes, two or three for vectors. */
  readonly value: readonly number[];
  /** `ActionPhase` bits, and their names. */
  readonly phase: number;
  readonly phases: readonly ActionPhaseName[];
  /** Seconds actuated. */
  readonly elapsed: number;
  /** Null when the action is at zero. */
  readonly source: InputSourceRow | null;
}

/** An active context of a player, highest priority first. */
export interface InputContextRow {
  readonly name: string;
  readonly priority: number;
  readonly mappings: number;
  /** The controls this context consumed this frame (lower contexts didn't see them). */
  readonly consumed: readonly string[];
}

export interface InputPlayerRow {
  readonly index: number;
  readonly name: string;
  readonly joinState: number;
  /** The family of the device that last performed an action (prompts follow it). */
  readonly lastFamily: DeviceFamily;
  readonly contexts: readonly InputContextRow[];
  readonly actions: readonly InputActionRow[];
  /** Problems compiling its contexts (unknown actions, bad control paths, bad parameters, missing contexts). */
  readonly problems: readonly string[];
  /** The rebind it is waiting on, if any. */
  readonly rebind: PendingRebind | null;
  /** The names of the nodes it controls (`ControlledBy`). */
  readonly pawns: readonly string[];
}

export interface InputWorldState {
  readonly world: string;
  /** Whether the World takes local input: only those have devices and evaluate actions. */
  readonly takesInput: boolean;
  readonly frame: number;
  readonly devices: readonly InputDeviceRow[];
  readonly players: readonly InputPlayerRow[];
}

const KINDS = ["keyboard", "pointer", "gamepad"] as const;
const PHASE_NAMES = Object.entries(ActionPhase) as [ActionPhaseName, number][];

/** The names of the `ActionPhase` bits set in `flags`. */
export function phaseNames(flags: number): ActionPhaseName[] {
  return PHASE_NAMES.filter(([, bit]) => (flags & bit) !== 0).map(([name]) => name);
}

/** Every device, player, context and action of `world` now (see the file comment). */
export function inputState(world: World): InputWorldState {
  const devices: InputDeviceRow[] = [];
  for (const node of deviceNodes(world)) {
    if (!node.isValid) continue;
    const d = node.getData(InputDevice);
    if (!d) continue;
    devices.push({ id: d.device, name: node.name, kind: KINDS[d.kind] ?? "gamepad", family: DEVICE_FAMILIES[d.family] ?? "generic", slot: d.slot, player: d.player, connected: d.connected !== 0 });
  }
  devices.sort((a, b) => kindOrder(a) - kindOrder(b) || a.slot - b.slot);
  const pawns = new Map<number, string[]>();
  for (const row of world._query([ControlledBy])) {
    const by = row.node.getData(ControlledBy);
    if (!by) continue;
    let list = pawns.get(by.player);
    if (!list) pawns.set(by.player, (list = []));
    list.push(row.node.name);
  }
  return {
    world: world.name,
    takesInput: takesLocalInput(world),
    frame: world.time.frameCount,
    devices,
    players: playerNodes(world).map((p) => playerRow(world, p, pawns)),
  };
}

const kindOrder = (d: InputDeviceRow) => (d.kind === "keyboard" ? DeviceKind.keyboard : d.kind === "pointer" ? DeviceKind.pointer : DeviceKind.gamepad);

function playerRow(world: World, player: GameObject, pawns: ReadonlyMap<number, string[]>): InputPlayerRow {
  const info = player.getData(InputPlayer)!;
  const table = playerTable(world, player);
  const trace = lastEvaluation(world, player);
  const consumedBy = new Map<string, string[]>();
  for (const [path, ctx] of trace?.consumed ?? []) {
    let list = consumedBy.get(ctx);
    if (!list) consumedBy.set(ctx, (list = []));
    list.push(path);
  }
  const actions: InputActionRow[] = [];
  for (const set of actionSets()) {
    const view = actionView(player, set) as Record<string, number> | null;
    for (const a of set.actions) {
      const phase = view ? view[a.phaseField] : 0;
      const m = trace?.sources.get(`${set.id}:${a.name}`);
      actions.push({
        set: set.id,
        action: a.name,
        kind: a.kind,
        value: a.valueFields.map((f) => (view ? view[f] : 0)),
        phase,
        phases: phaseNames(phase),
        elapsed: view ? view[a.timeField] : 0,
        source: m ? sourceRow(m) : null,
      });
    }
  }
  return {
    index: info.index,
    name: player.name,
    joinState: info.joinState,
    lastFamily: DEVICE_FAMILIES[info.lastFamily] ?? "keyboard",
    contexts: table.contexts.map((c) => ({ name: c.name, priority: c.priority, mappings: c.mappings.length, consumed: consumedBy.get(c.name) ?? [] })),
    actions,
    problems: [...table.problems],
    rebind: pendingRebind(player),
    pawns: pawns.get(info.index) ?? [],
  };
}

function sourceRow(m: CompiledMapping): InputSourceRow {
  const s = m.source;
  const controls = s.kind === "single" ? [s.control] : s.kind === "dpad" ? [s.up, s.down, s.left, s.right] : s.kind === "axis" ? [s.negative, s.positive] : [...s.modifiers, s.control];
  return { context: m.context, mapping: m.index, composite: s.kind, controls: controls.map((c) => c.path) };
}

// --- the event log -------------------------------------------------------------------------------

interface LogBase {
  /** The World's frame count when it happened. */
  readonly frame: number;
  /** The World's unscaled time since start-up, in seconds. */
  readonly time: number;
}

/** One recorded input event. */
export type InputLogEntry = LogBase &
  (
    | { readonly kind: "action"; readonly player: number; readonly set: string; readonly action: string; readonly phase: ActionEventPhase; readonly value: number }
    | { readonly kind: "device"; readonly device: string; readonly control: string; readonly value: number }
    | { readonly kind: "joined" | "left"; readonly player: number }
    | { readonly kind: "rebind"; readonly player: number; readonly action: string; readonly control: string | null; readonly canceled: boolean; readonly conflicts: readonly string[] }
  );

/** A running log of one World's input events (`watchInput`). */
export interface InputLog {
  /** The recorded events, oldest first; at most `limit` (the newest). */
  entries(): readonly InputLogEntry[];
  /** Bumped whenever events are recorded. */
  readonly version: number;
  /** Forget what was recorded. */
  clear(): void;
  /** Stop recording (the system goes once nothing watches). */
  stop(): void;
}

interface Recorder {
  readonly limit: number;
  list: InputLogEntry[];
  version: number;
}

const recorders = new Map<World, Set<Recorder>>();

const playerIndex = (node: GameObject) => (node.isValid ? (node.getData(InputPlayer)?.index ?? -1) : -1);

function record(world: World): void {
  const set = recorders.get(world);
  if (!set?.size) return;
  const base = { frame: world.time.frameCount, time: world.time.realtimeSinceStartup };
  const found: InputLogEntry[] = [];
  for (const e of DeviceEvents.read()) found.push({ ...base, kind: "device", device: e.device.isValid ? e.device.name : "?", control: e.control, value: e.value });
  for (const e of PlayerJoined.read()) found.push({ ...base, kind: "joined", player: e.index });
  for (const e of ActionEvents.read()) found.push({ ...base, kind: "action", player: playerIndex(e.player), set: e.set.id, action: e.action, phase: e.phase, value: e.value });
  for (const e of RebindResults.read()) found.push({ ...base, kind: "rebind", player: playerIndex(e.player), action: e.action, control: e.control, canceled: e.canceled, conflicts: [...e.conflicts] });
  for (const e of PlayerLeft.read()) found.push({ ...base, kind: "left", player: e.index });
  if (!found.length) return;
  for (const r of set) {
    r.list.push(...found);
    if (r.list.length > r.limit) r.list.splice(0, r.list.length - r.limit);
    r.version++;
  }
}

/** Records every World that something watches; defined while anything does. lateUpdate: after everything that appends to the buffers, before they're cleared. */
const LOG_SYSTEM: BuiltinSystem = { name: "engine.InputDebugLog", phase: "lateUpdate", run: (w) => record(w) };

/** Start recording `world`'s input events, keeping the newest `limit`. */
export function watchInput(world: World, limit = 200): InputLog {
  const r: Recorder = { limit, list: [], version: 0 };
  if (recorders.size === 0) defineBuiltinSystem(LOG_SYSTEM);
  let set = recorders.get(world);
  if (!set) recorders.set(world, (set = new Set()));
  set.add(r);
  let stopped = false;
  return {
    entries: () => r.list,
    get version() {
      return r.version;
    },
    clear() {
      r.list = [];
      r.version++;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const s = recorders.get(world);
      s?.delete(r);
      if (s && s.size === 0) recorders.delete(world);
      if (recorders.size === 0) _undefineBuiltinSystem(LOG_SYSTEM);
    },
  };
}

// --- for the context asset editor ----------------------------------------------------------------

/** A defined action set and its actions. */
export interface InputActionSetInfo {
  readonly id: string;
  /** Each action, with the controls given inline in `defineActions` (ADR 0336) as mappings naming it: the default context's mappings from a script. */
  readonly actions: readonly { readonly name: string; readonly kind: ActionKind; readonly consume?: boolean; readonly defaults?: readonly MappingSpec[] }[];
  /** Where it came from (ADR 0417): `defineActions` in code, or an `*.actions.json` asset. */
  readonly source?: "code" | "asset";
  /** Both a script and an asset defined this id (ADR 0417); the asset's set is used. */
  readonly clash?: boolean;
}

/** Every action set the engine and the project's scripts and set assets define, in definition order. */
export function inputActionSets(): InputActionSetInfo[] {
  const clashes = actionSetClashes();
  return actionSets().map((s) => ({
    id: s.id,
    actions: s.actions.map((a) => ({
      name: a.name,
      kind: a.kind,
      ...(a.type.options.consume !== undefined ? { consume: a.type.options.consume } : {}),
      defaults: a.type.defaults.map((d): MappingSpec => (typeof d === "string" ? { action: `${s.id}:${a.name}`, control: d } : { ...d, action: `${s.id}:${a.name}` })),
    })),
    source: actionSetSource(s.id)?.source ?? "code",
    ...(clashes.has(s.id) ? { clash: true } : {}),
  }));
}

/**
 * What a control path reads, for the context editor's warnings and new actions' types (ADR 0417): its components
 * (1, 2 or 3) and, for one component, whether it's a button (keys, mouse and gamepad buttons, triggers read as
 * buttons) or an axis (a stick's X or Y). Null if the path names no control.
 */
export function inputControlInfo(path: string): { readonly dimensions: 1 | 2 | 3; readonly axis: boolean } | null {
  const c = control(path);
  if (!c) return null;
  const read = (c.source as { read?: string }).read;
  return { dimensions: c.dimensions, axis: c.dimensions === 1 && read === "axis" };
}

/** The names of the contexts scripts register with `defineInputContext`, and the default context's. */
export function inputContextNames(): string[] {
  return [DEFAULT_CONTEXT, ...registeredContexts()];
}

/**
 * Every named control path the engine parses, grouped by device in the order a picker lists them: Pointer, Gamepad,
 * Touch, Pen (keys aren't listed: any `KeyboardEvent.key` names one).
 */
export function inputControlPaths(): { readonly device: string; readonly controls: readonly string[] }[] {
  const names = { pointer: "Pointer", gamepad: "Gamepad", touch: "Touch", pen: "Pen" } as const;
  return namedControlPaths().map((g) => ({ device: names[g.device], controls: g.paths }));
}

/** A control path's canonical form (`<keyboard>/Space` → `<Keyboard>/space`), or null if it names no control. */
export function canonicalControlPath(path: string): string | null {
  return control(path)?.path ?? null;
}

/** One modifier's part in a value tried through a mapping's stack (`traceInputModifiers`). */
export interface ModifierTraceStep {
  /** The value it hands on: the first `dims` components. */
  readonly value: readonly number[];
  /** Why the modifier can't run (its parameters are bad), as Play reports it; the value then passes through. */
  readonly error: string | null;
  /** It depends on time (`smooth`), so a single value passes through unchanged. */
  readonly timeBased: boolean;
  /** Added by the engine, not the mapping: a stick's dead zone when the mapping has none (the default 0.15). */
  readonly implicit: boolean;
  /** Turned off (`off: true`): skipped, the value passes through. */
  readonly off: boolean;
}

/** A value tried through a mapping's modifiers: each step's output, and what the action gets. */
export interface ModifierTrace {
  /** The components the modifiers run on: the more of the input's and the action's. */
  readonly dims: number;
  readonly steps: readonly ModifierTraceStep[];
  /** The last step's value as the action's type reads it (a button: the magnitude, up to 1). */
  readonly out: readonly number[];
}

const KIND_DIMS = { button: 1, axis: 1, vec2: 2, vec3: 3 } as const;

/**
 * `input` passed through `modifiers` top to bottom as Play runs them (ADR 0336, 0417): the engine's own modifier
 * functions, on as many components as the larger of the input's and the action's (`kind`). `controls` are the
 * mapping's control paths: when one is a gamepad stick and the stack has no dead zone, the engine's default one runs
 * first and shows as an implicit step. `smooth` follows its input over time, so one value passes through it, and a
 * turned-off modifier (`off: true`) is skipped.
 */
export function traceInputModifiers(modifiers: readonly ModifierSpec[], input: readonly number[], options: { readonly kind?: ActionKind; readonly controls?: readonly string[] } = {}): ModifierTrace {
  const dims = Math.max(1, Math.min(3, Math.max(input.length, options.kind ? KIND_DIMS[options.kind] : 1)));
  const v = new Float32Array(3);
  for (let i = 0; i < Math.min(3, input.length); i++) v[i] = input[i];
  const stick = (options.controls ?? []).some((p) => {
    const src = control(p)?.source as { device?: string; read?: string } | undefined;
    return src?.device === "gamepad" && (src.read === "stick" || src.read === "axis");
  });
  const specs: { spec: ModifierSpec; implicit: boolean }[] = modifiers.map((spec) => ({ spec, implicit: false }));
  if (stick && !modifiers.some((m) => "deadzone" in m && !m.off)) specs.unshift({ spec: { deadzone: { min: DEFAULT_STICK_DEADZONE } }, implicit: true });
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const steps = specs.map(({ spec, implicit }): ModifierTraceStep => {
    const timeBased = "smooth" in spec;
    let error: string | null = null;
    if (spec.off) return { value: Array.from(v.subarray(0, dims), round), error, timeBased, implicit, off: true };
    try {
      const run = compileModifier(spec);
      if (!timeBased) run(v, dims, 0);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { value: Array.from(v.subarray(0, dims), round), error, timeBased, implicit, off: false };
  });
  const out = Float32Array.from(v);
  if (options.kind === "button") out[0] = Math.min(1, Math.sqrt(out[0] * out[0] + (dims > 1 ? out[1] * out[1] : 0) + (dims > 2 ? out[2] * out[2] : 0)));
  return { dims, steps, out: Array.from(out.subarray(0, options.kind ? KIND_DIMS[options.kind] : dims), round) };
}

/** The problems the evaluator reports for a context, each with its mapping's index: the messages Play would log. */
export function inputContextProblems(spec: InputContextSpec): { readonly mapping: number; readonly message: string }[] {
  return contextProblems(spec);
}

// --- raw presses (Bind) ----------------------------------------------------------------------------

/** One press the device snapshot saw. */
export interface RawPress {
  /** What pressed it. */
  readonly device: "keyboard" | "pointer" | "touch" | "pen" | "gamepad";
  /** The control's path as the engine names it: `<Keyboard>/k`, `<Pointer>/button0`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`, `<Touch>/touch0`, `<Pen>/tip`. */
  readonly control: string;
  /** The value it reached: 1 for keys and digital buttons, an analog button's 0..1, a stick axis's -1..1. */
  readonly value: number;
}

const deviceOf = (id: number): RawPress["device"] => (id === KEYBOARD_DEVICE ? "keyboard" : id === POINTER_DEVICE ? "pointer" : id === TOUCH_DEVICE ? "touch" : id === PEN_DEVICE ? "pen" : "gamepad");

/** The snapshot counts as stalled (nothing steps an Engine: play paused, or no Engine running) after this long without one. */
const STALLED_MS = 200;
const PUMP_MS = 50;

/**
 * Call `callback` with every press the Engine's device snapshot sees from now on (releases aren't presses; a stick
 * counts when it crosses the press point): keyboard, mouse, every gamepad adapter (the Gamepad API, WebHID, SDL on
 * desktop), touch and pen, after the snapshot's own UI routing. Runs with or without a play World: the snapshot is
 * read at the start of each Engine frame, and while no Engine steps it (play paused, nothing running) this takes the
 * snapshot itself so presses still arrive. Returns a function that stops.
 */
export function watchRawPresses(callback: (press: RawPress) => void): () => void {
  let seen = devices.frame; // events already in the snapshot happened before this call
  let lastFrameAt = performance.now();
  let stopped = false;
  const read = () => {
    if (stopped || devices.frame === seen) return;
    seen = devices.frame;
    lastFrameAt = performance.now();
    for (const e of devices.events) {
      const gamepadAxis = e.control.startsWith("<Gamepad>/") && /Stick[XY]$/.test(e.control);
      if (gamepadAxis ? Math.abs(e.value) < PRESS_POINT : e.value < PRESS_POINT) continue;
      callback({ device: deviceOf(e.device), control: e.control, value: e.value });
      if (stopped) return;
    }
  };
  // At the start of each snapshot the previous frame's events are still there: read them before they're replaced.
  const removePoller = devices.addPoller(read);
  const pump = setInterval(() => {
    read();
    if (stopped || performance.now() - lastFrameAt < STALLED_MS) return;
    Input.beginFrame(); // nothing is taking snapshots: take one, so the adapters are polled and their events applied
    read();
  }, PUMP_MS);
  return () => {
    if (stopped) return;
    stopped = true;
    removePoller();
    clearInterval(pump);
  };
}

// --- hardware recording -------------------------------------------------------------------------

/**
 * Start recording the gamepad adapters' raw input: WebHID input reports (with each device's descriptor and setup
 * exchange), SDL batches on desktop, and Gamepad API readings, until `stop()` returns the recording (a JSON value,
 * format `myco-input-recording` version 1; `input/replay.ts` plays it back through the same adapters).
 */
export function recordInput(): InputRecorder {
  return startInputRecording();
}
