/**
 * A ready-made rebinding screen (ADR 0337, Rewired's Control Mapper): `UIControlMapper` builds a
 * panel of UI elements as its node's children listing a player's actions with their keyboard and
 * gamepad bindings (glyph and label, following the device family the player last used), and
 * rebinds the one the player clicks through `PlayerInput.rebind` (an empty cell gets a binding
 * added), unbinds the focused one (Delete, Backspace, or the Unbind button for the cell last
 * focused), reports conflicts, resets to the defaults and saves with `saveBindings`. A chord
 * ("Shift + B") is one cell whose rebind takes the keys or buttons pressed together. With
 * `showAccessibility` it also edits the player's accessibility settings (invert Y, sensitivity,
 * hold-to-toggle, repeat, stick dead zone), which Save writes with the bindings.
 *
 * Every cell, toggle, stepper button and Unbind, Reset and Save is a focusable `UIButton`, driven by
 * the game UI's focus navigation (ADR 0340): the mouse clicks, and the arrow keys, d-pad and left
 * stick (`navigate`) move focus while Enter, Space and the south button (`submit`) click the focused
 * button. The mapper keeps no selection of its own and acts on clicks only. Its screen takes focus
 * when it appears (its own canvas has `autoFocus`; under a game's canvas it focuses its first cell
 * unless something on that canvas has focus), and a player's presses don't move focus while their
 * rebind waits (navigation skips a player with a pending rebind). The focused element always shows
 * `accentColor` as its border, even after the mouse moved focus, because Delete, Backspace and
 * Unbind act on it; its `focusColor` fill (`hoverColor`) shows only while navigating, as on any
 * button. Delete and Backspace are read as the player's device events while one of its cells has
 * focus: they're the screen's editing keys, like a text field's, not game actions (an action set
 * for them would show up in every list of actions, this screen's included).
 *
 * It is drawn by a built-in Svelte component (ADR 0419 wave B), `@myco/ui/ControlMapper.svelte`, mounted by a
 * `UIView` on a child node it makes: the mapper works out what the screen shows each frame and passes it in as the
 * view's props, and finds the rendered buttons by id (its cells', toggles', steppers', Unbind's, Reset's and Save's
 * `UIButton`s). The view has a screen canvas of its own (`sortOrder` 100, `autoFocus`); under a game's canvas, the
 * view's canvas takes that canvas's settings and draws just above it. Its node belongs to the mapper: it isn't in the
 * scene file and goes when the mapper does. The editor and Vitest compile the component with the engine's build; a game
 * build compiles it into the game's own code when the project uses a control mapper (ADR 0421).
 */
import { Component } from "../../../engine/core/Component";
import { Color } from "../../../engine/core/math";
import { component, field, getComponentClass } from "../../../engine/core/registry";
import { defineBuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import type { GameObject } from "../../../engine/scene/GameObject";
import { actionSets } from "../../../engine/input/actions";
import { DEFAULT_CONTEXT } from "../../../engine/input/contexts";
import { control, type DeviceFamily } from "../../../engine/input/controls";
import { DeviceEvents, DeviceKind, InputDevice } from "../../../engine/input/deviceEntities";
import { DEFAULT_STICK_DEADZONE } from "../../../engine/input/evaluate";
import { InputPlayers, type PlayerInput } from "../../../engine/input/facade";
import { InputGlyphs } from "../../../engine/input/glyphs";
import { familyName } from "../../../engine/input/players";
import type { InputAccessibility } from "../../../engine/input/profiles";
import { controlLabel, type InputPrompt } from "../../../engine/input/prompts";
import { RebindResults, type RebindResult } from "../../../engine/input/rebind";
import { UIButton, UICanvas, UIPanel, type UILength } from "../../../engine/ui/components";
import { uiInteractions } from "../../../engine/ui/interactions";
import { UIView } from "./UIView";

export interface UIControlMapperText {
  keyboard: string;
  gamepad: string;
  action: string;
  /** The button that unbinds the focused cell, or the one last focused. */
  unbind: string;
  reset: string;
  save: string;
  /** In the cell being rebound. */
  pressKey: string;
  pressButton: string;
  /** The status line while waiting; `{cancel}` is the cancel key's label. */
  waitingKey: string;
  waitingButton: string;
  /** No binding for that device. */
  none: string;
  bound: string;
  canceled: string;
  /** `{control}` and `{actions}` are filled in. */
  conflict: string;
  /** After unbinding; `{action}` is filled in. */
  unbound: string;
  resetDone: string;
  saved: string;
  saveFailed: string;
  noPlayer: string;
  /** Part names of composite bindings, after the action's name ("Move Up"). */
  parts: Record<string, string>;
  /** Between a chord's controls ("Shift + B"). */
  chord: string;
  /** In a chord's cell being rebound. */
  pressChordKey: string;
  pressChordButton: string;
  /** The status line while waiting for a chord; `{cancel}` is the cancel key's label. */
  waitingChordKey: string;
  waitingChordButton: string;
  /** The accessibility section's heading and rows; `{action}` is the action's display name. */
  accessibility: string;
  invertY: string;
  sensitivity: string;
  holdToToggle: string;
  repeat: string;
  repeatDelay: string;
  repeatInterval: string;
  deadzone: string;
  /** A toggle's value. */
  on: string;
  off: string;
  /** A stepper's buttons. */
  decrease: string;
  increase: string;
  /** Stepper values: `{value}` is the number. */
  multiplier: string;
  seconds: string;
  percent: string;
}

const DEFAULT_TEXT: UIControlMapperText = {
  keyboard: "Keyboard",
  gamepad: "Gamepad",
  action: "Action",
  unbind: "Unbind",
  reset: "Reset to defaults",
  save: "Save",
  pressKey: "Press a key…",
  pressButton: "Press a button…",
  waitingKey: "Press a key… ({cancel} to cancel)",
  waitingButton: "Press a button… ({cancel} to cancel)",
  none: "—",
  bound: "{action}: {control}",
  canceled: "Canceled.",
  conflict: "{control} is also bound to {actions}.",
  unbound: "{action}: unbound.",
  resetDone: "Bindings reset to the defaults.",
  saved: "Saved.",
  saveFailed: "Couldn't save the bindings.",
  noPlayer: "There's no player {player}.",
  parts: { up: "Up", down: "Down", left: "Left", right: "Right", negative: "−", positive: "+" },
  chord: " + ",
  pressChordKey: "Press the keys…",
  pressChordButton: "Press the buttons…",
  waitingChordKey: "Hold the keys together, then let go… ({cancel} to cancel)",
  waitingChordButton: "Hold the buttons together, then let go… ({cancel} to cancel)",
  accessibility: "Accessibility",
  invertY: "{action}: Invert Y",
  sensitivity: "{action}: Sensitivity",
  holdToToggle: "{action}: Press to toggle",
  repeat: "Repeat held buttons",
  repeatDelay: "Repeat delay",
  repeatInterval: "Repeat interval",
  deadzone: "Stick dead zone",
  on: "On",
  off: "Off",
  decrease: "−",
  increase: "+",
  multiplier: "{value}×",
  seconds: "{value} s",
  percent: "{value}%",
};

/** A device column. */
export type UIControlMapperDevice = "keyboard" | "gamepad";

/** One binding cell: what it shows and the button that rebinds it. */
export interface UIControlMapperCell {
  /** The action of the cell's row. */
  readonly action: string;
  readonly device: UIControlMapperDevice;
  /** The control's label ("Space", "A", "Shift+B"), or the `none` text when the device has no binding. */
  readonly label: string;
  /** The glyphs' icon keys. */
  readonly icons: readonly string[];
  /** The rebind part (`control`, `up`…), or null when there's no binding to rebind. */
  readonly part: string | null;
  /** True when the action has no binding for this device: rebinding the cell adds one. */
  readonly adds: boolean;
  /** A chord (modifiers and a main control): its rebind takes the controls pressed together. */
  readonly chord: boolean;
  /** True when another listed action's binding for this device uses the same control. */
  readonly conflict: boolean;
  /** The button: click it (or focus it and press Enter, Space or the south button) to rebind; focus it and press Delete or Backspace to unbind. */
  readonly button: UIButton;
}

/** One row: an action, or one part of a composite binding (Move Up, Move Down…). */
export interface UIControlMapperRow {
  readonly action: string;
  /** The composite part the row is for (`up`, `negative`…), or null. */
  readonly part: string | null;
  readonly label: string;
  readonly keyboard: UIControlMapperCell | null;
  readonly gamepad: UIControlMapperCell | null;
}

/** An accessibility setting the screen edits. */
export type UIControlMapperSettingKind = "invertY" | "sensitivity" | "holdToToggle" | "repeat" | "repeatDelay" | "repeatInterval" | "deadzone";

/** One accessibility row: a toggle (On/Off) or a stepper (− value +). */
export interface UIControlMapperSetting {
  readonly setting: UIControlMapperSettingKind;
  /** The action it's for (invert Y, sensitivity, hold-to-toggle), or null. */
  readonly action: string | null;
  readonly label: string;
  /** What it shows: the `on` or `off` text, or the stepper's value ("1.5×", "0.4 s", "15%"). */
  readonly value: string;
  /** False for the repeat steppers while repeat is off. */
  readonly enabled: boolean;
  /** A toggle's button, or null for a stepper. These buttons are focusable, like the cells. */
  readonly toggle: UIButton | null;
  /** A stepper's buttons, or null for a toggle. */
  readonly decrease: UIButton | null;
  readonly increase: UIButton | null;
}

interface Entry {
  readonly part: string;
  readonly label: string;
  readonly icons: readonly string[];
  readonly controls: readonly string[];
  readonly chord: boolean;
}


interface CellState {
  action: string;
  device: UIControlMapperDevice;
  label: string;
  icons: readonly string[];
  part: string | null;
  adds: boolean;
  context: string | null;
  controls: readonly string[];
  chord: boolean;
  conflict: boolean;
  /** The element id the view gives its button. */
  id: string;
  /** The rendered button (found by `id` once the view has drawn the row). */
  button: UIButton | null;
}

interface SettingState {
  setting: UIControlMapperSettingKind;
  action: string | null;
  label: string;
  value: string;
  enabled: boolean;
  /** The element ids of its buttons (a toggle's, or a stepper's two). */
  ids: { toggle: string | null; decrease: string | null; increase: string | null };
  toggle: UIButton | null;
  decrease: UIButton | null;
  increase: UIButton | null;
}
/** A button of an accessibility row. */
interface SettingColumn {
  readonly row: SettingState;
  readonly op: "toggle" | "decrease" | "increase";
}

/** What a button of the screen does when clicked. */
type Target = { readonly kind: "cell"; readonly row: number; readonly cell: CellState } | { readonly kind: "setting"; readonly column: SettingColumn } | { readonly kind: "unbind" | "reset" | "save" };

/** Stepper ranges: step, least and most. */
const STEPPERS: Record<"sensitivity" | "repeatDelay" | "repeatInterval" | "deadzone", { step: number; min: number; max: number }> = {
  sensitivity: { step: 0.1, min: 0.1, max: 5 },
  repeatDelay: { step: 0.05, min: 0, max: 2 },
  repeatInterval: { step: 0.05, min: 0.05, max: 1 },
  deadzone: { step: 0.05, min: 0, max: 0.9 },
};
const DEFAULT_REPEAT = { delay: 0.4, interval: 0.1 };

interface RowState {
  action: string;
  part: string | null;
  label: string;
  keyboard: CellState | null;
  gamepad: CellState | null;
}

interface Built {
  /** The node of the view it draws with. */
  root: GameObject;
  view: UIView;
  /** The game's canvas above it, or null when its view's canvas is its own screen canvas. */
  above: UICanvas | null;
  /** Bumped when the rows' shape changes: the view makes their elements afresh. */
  rowsGeneration: number;
  settingsGeneration: number;
  settingsSignature: string;
  settings: SettingState[];
  unbind: UIButton | null;
  reset: UIButton | null;
  save: UIButton | null;
  signature: string;
  rows: RowState[];
  /** The view has mounted its component. */
  mounted: boolean;
  /** The model last passed to the view, as JSON. */
  shown: string;
  /** After the rows' shape changed: where focus goes once the view has drawn them. */
  anchor: { row: number; device: UIControlMapperDevice; focused: boolean } | null;
  /** After the settings' shape changed while one of them had focus: focus goes back to the cells once drawn. */
  refocusSettings: boolean;
}

/** What the view draws (`ControlMapper.svelte`'s `model` prop): plain data. */
interface Nav {
  up: string | null;
  down: string | null;
  left: string | null;
  right: string | null;
}
interface ViewCell {
  id: string;
  label: string;
  glyphs: { asset: string; width: number; height: number }[];
  tone: "text" | "muted" | "warning";
  waiting: boolean;
  interactable: boolean;
}
interface ViewButton {
  id: string;
  interactable: boolean;
}
interface ViewModel {
  title: string;
  headers: { action: string; keyboard: string | null; gamepad: string | null };
  rows: { key: string; label: string; keyboard: ViewCell | null; gamepad: ViewCell | null }[];
  accessibility: string | null;
  settings: { key: string; label: string; value: string; enabled: boolean; toggle: ViewButton | null; decrease: ViewButton | null; increase: ViewButton | null }[];
  decrease: string;
  increase: string;
  status: string;
  statusWarning: boolean;
  unbind: { label: string; enabled: boolean };
  reset: string;
  save: string;
  /** The id of the button that has focus, which shows the accent border. */
  focus: string | null;
  look: { width: string; fontSize: number; glyphSize: number; colors: Record<string, string> };
}

/** The built-in component the screen is drawn with (ADR 0419 wave B). */
export const CONTROL_MAPPER_COMPONENT = "@myco/ui/ControlMapper.svelte";

/** The UI actions' set (ADR 0340): listed only when `actions` names it. */
const UI_ACTIONS_SET = "engine.UIActions";
/** The screen's editing keys, read as the player's device events while one of its cells has focus. */
const UNBIND = new Set(["<Keyboard>/delete", "<Keyboard>/backspace"]);

const live = new Set<UIControlMapper>();
let warnedNoUI = false;

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
/** "jumpHigh" → "Jump High". */
const titleCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * A rebinding screen for one player: put it on any node (it draws on a screen canvas of its own, or
 * just above a game's canvas it's under). Rows list the actions (`actions`, or every defined action), one per
 * part for a composite binding (Move Up, Move Down…), with a keyboard and a gamepad cell. Clicking
 * a cell (with the mouse, or `submit` on it after focus navigation brought focus there) waits for
 * the player's next press (`PlayerInput.rebind`, adding a binding when the cell is empty; Escape
 * cancels) and shows any conflict. Delete or Backspace on the focused cell, or **Unbind** (for the
 * cell last focused), removes its binding (`PlayerInput.unbind`). **Reset to defaults** drops the
 * player's changes; **Save** writes them with `saveBindings`.
 */
@component("engine.UIControlMapper")
export class UIControlMapper extends Component {
  /** The player's index. */
  @field(Number) player = 0;
  /** The actions to list, comma-separated (`"jump, move, game.Vehicle:honk"`); empty lists every action of every action set but the engine's UI actions (`engine.UIActions`, listed only when named here). */
  @field(String) actions = "";
  /** Keep focus in the screen (its canvas's `modal`) while it's shown. Only for the canvas it makes; under a game's canvas, set that canvas's `modal`. */
  @field(Boolean) modal = false;
  /** Show the keyboard (and mouse) column. */
  @field(Boolean) keyboard = true;
  /** Show the gamepad column. */
  @field(Boolean) gamepad = true;
  /** Profile name for `saveBindings` (empty: `player<index>`). */
  @field(String) profile = "";
  /** Seconds to wait for a press before giving up (0: wait until a press or Escape). */
  @field(Number) timeout = 10;
  /** Show the accessibility section below the bindings: the rows the next four fields ask for, then repeat and the stick dead zone. */
  @field(Boolean) showAccessibility = false;
  /** Vector or axis actions with an Invert Y toggle, comma-separated (`"look"`). */
  @field(String) invertYActions = "";
  /** Actions with a sensitivity stepper, comma-separated. */
  @field(String) sensitivityActions = "";
  /** Button actions with a press-to-toggle switch (hold-to-toggle), comma-separated. */
  @field(String) holdToToggleActions = "";
  /** The button actions that repeat when repeat is on, comma-separated (empty: every button action). */
  @field(String) repeatActions = "";
  @field(String) title = "Controls";
  /** The panel's width in UI pixels (`720`), a percentage, or `"auto"`. */
  @field(String) width: UILength = "720";
  @field(Number) fontSize = 18;
  /** Glyph height in UI pixels. */
  @field(Number) glyphSize = 30;
  @field(Color) backgroundColor = new Color(0.1, 0.11, 0.13, 0.96);
  @field(Color) cellColor = new Color(0.24, 0.27, 0.32, 1);
  @field(Color) hoverColor = new Color(0.33, 0.36, 0.43, 1);
  @field(Color) pressedColor = new Color(0.17, 0.19, 0.23, 1);
  /** The focused button's border (shown after mouse use too), and the cell waiting for a press. */
  @field(Color) accentColor = new Color(0.36, 0.62, 1, 1);
  @field(Color) textColor = Color.white;
  @field(Color) mutedColor = new Color(1, 1, 1, 0.6);
  /** Conflicting bindings and warnings. */
  @field(Color) warningColor = new Color(1, 0.72, 0.3, 1);

  /** Words it shows (change them to translate). Display names for actions go in `actionLabels`. */
  text: UIControlMapperText = { ...DEFAULT_TEXT, parts: { ...DEFAULT_TEXT.parts } };
  /** Display names by action name (`{ jump: "Jump", "game.Vehicle:honk": "Horn" }`); others are title-cased. */
  actionLabels: Record<string, string> = {};

  private built: Built | null = null;
  /** The binding cell last focused: what Unbind acts on once focus has moved to it. */
  private lastCell: CellState | null = null;
  /** Under a game's canvas: the first cell has been given focus since the screen became active. */
  private focusGiven = false;
  private waiting: { action: string; device: UIControlMapperDevice; cell: CellState; chord: boolean } | null = null;
  /** Repeat's delay and interval while it's off, for when it's turned back on. */
  private repeatMemory = { ...DEFAULT_REPEAT };
  private statusMessage = "";
  private statusWarning = false;
  private lastConflicts: readonly string[] = [];
  private saving = 0;

  // --- What scripts read ------------------------------------------------------------------------

  /** The rows as last shown (empty before the first frame). */
  get rows(): readonly UIControlMapperRow[] {
    return (this.built?.rows ?? []).map((r) => ({ action: r.action, part: r.part, label: r.label, keyboard: r.keyboard && cellView(r.keyboard), gamepad: r.gamepad && cellView(r.gamepad) }));
  }

  /** The accessibility rows as last shown (empty unless `showAccessibility`). */
  get settings(): readonly UIControlMapperSetting[] {
    return (this.built?.settings ?? []).map((r) => ({ setting: r.setting, action: r.action, label: r.label, value: r.value, enabled: r.enabled, toggle: r.toggle, decrease: r.decrease, increase: r.increase }));
  }

  /** The rebind being waited for, or null. */
  get rebinding(): { readonly action: string; readonly device: UIControlMapperDevice } | null {
    return this.waiting ? { action: this.waiting.action, device: this.waiting.device } : null;
  }

  /** The status line ("Press a key… (Esc to cancel)", a conflict, "Saved."). */
  get status(): string {
    return this.statusMessage;
  }

  /** The conflicts the last rebind reported, as `"<context>: <action>"`. */
  get conflicts(): readonly string[] {
    return this.lastConflicts;
  }

  /**
   * The binding cell that has focus (ADR 0340), or null when focus is elsewhere (an accessibility
   * row, a button, another screen). Delete and Backspace unbind it. To move focus, set a cell's
   * `button.focused`.
   */
  get focusedCell(): UIControlMapperCell | null {
    const c = this.built && this.focusedCellState(this.built);
    return c ? cellView(c) : null;
  }

  /** The Unbind, Reset and Save buttons (null before the first frame). Unbind acts on the focused binding cell, or the one last focused. */
  get unbindButton(): UIButton | null {
    return this.built?.unbind ?? null;
  }

  get resetButton(): UIButton | null {
    return this.built?.reset ?? null;
  }

  get saveButton(): UIButton | null {
    return this.built?.save ?? null;
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  /** @internal */
  override _onActivate(): void {
    live.add(this);
    this.focusGiven = false;
    if (this.built?.root.isValid) this.built.root.setActive(true);
  }

  /** @internal */
  override _onDeactivate(): void {
    live.delete(this);
    if (this.built?.root.isValid) this.built.root.setActive(false);
  }

  /** @internal */
  override _onDetach(): void {
    live.delete(this);
    const root = this.built?.root;
    this.built = null;
    // Called while the World flushes its destroys: queue the tree (that flush picks it up).
    if (root?.isValid) root.world._destroyNode(root.entity);
  }


  // --- The frame --------------------------------------------------------------------------------

  /** @internal Read the player's bindings, handle clicks, presses and rebind results, and update the view. */
  _frame(world: World): void {
    if (getComponentClass("engine.UIPanel") !== UIPanel) {
      // The UI plugin is off (ADR 0140): there are no UI elements to build.
      if (!warnedNoUI) console.warn("[myco] UIControlMapper needs the UI plugin, which is disabled.");
      warnedNoUI = true;
      return;
    }
    const built = (this.built ??= this.build(world));
    this.copyCanvas(built);
    // The view mounts once the UI cascade has loaded (the first time a World has a view).
    if (!built.mounted) return;
    const input = InputPlayers.get(this.player);
    const finished = input ? this.collectResults(input) : false;
    this.syncRows(built, input);
    this.syncSettings(built, input);
    this.render(built);
    this.giveFocus(world, built);
    this.noteFocusedCell(built);
    if (input && !this.waiting && !finished) this.handleInput(built, input);
    this.noteFocusedCell(built);
    this.render(built);
  }

  /** Focus the first cell once the rows are there, unless something on its canvas (the game's above it, or its view's own) has focus. */
  private giveFocus(world: World, built: Built): void {
    if (this.focusGiven || !built.rows.length) return;
    this.focusGiven = true;
    const canvas = built.above ?? built.view.root?.as(UICanvas) ?? null;
    const focused = uiInteractions(world).focused;
    if (focused?.node.isValid && focused.isActiveAndEnabled && canvasOf(focused.owner) === canvas) return;
    const first = this.firstCell(built);
    if (first?.button) first.button.focused = true;
  }

  /** Remember the focused binding cell: what Unbind acts on once focus has moved to the button. */
  private noteFocusedCell(built: Built): void {
    const c = this.focusedCellState(built);
    if (c) this.lastCell = c;
  }

  /** The binding cell that has focus, or null. */
  private focusedCellState(built: Built): CellState | null {
    for (const r of built.rows) for (const c of [r.keyboard, r.gamepad]) if (c?.button?.focused) return c;
    return null;
  }

  /** The first cell that does something (rebinds or adds), or null. */
  private firstCell(built: Built, device?: UIControlMapperDevice): CellState | null {
    for (const r of built.rows) for (const c of [r.keyboard, r.gamepad]) if (c && (!device || c.device === device) && (c.part !== null || c.adds)) return c;
    return null;
  }

  private collectResults(input: PlayerInput): boolean {
    const w = this.waiting;
    if (!w) return false;
    let result: RebindResult | null = null;
    for (const r of RebindResults.read()) if (r.player === input.player && r.action === w.action) result = r;
    if (!result) {
      if (!input.player?.isValid) this.waiting = null;
      return false;
    }
    this.waiting = null;
    this.lastConflicts = result.conflicts;
    if (result.canceled || !result.control) {
      this.setStatus(this.text.canceled);
      return true;
    }
    const label = result.chord.length > 1 ? this.chordLabel(input, w.device, result.chord) : this.controlLabel(input, w.action, w.device, result.control);
    if (result.conflicts.length) {
      const names = result.conflicts.map((c) => {
        const colon = c.indexOf(": ");
        const ctx = c.slice(0, colon);
        const action = this.labelOf(c.slice(colon + 2));
        return ctx === DEFAULT_CONTEXT ? action : `${action} (${ctx})`;
      });
      this.setStatus(fill(this.text.conflict, { control: label, actions: names.join(", ") }), true);
    } else this.setStatus(fill(this.text.bound, { action: this.labelOf(w.action), control: label }));
    return true;
  }

  /** The label of a control as the given device's prompt names it (after the rebind recompiles). */
  private controlLabel(input: PlayerInput, action: string, device: UIControlMapperDevice, path: string): string {
    const prompt = this.promptOf(input, action, device);
    const i = prompt?.controls.indexOf(path) ?? -1;
    if (prompt && i >= 0) return prompt.labels[i];
    return path.slice(path.indexOf("/") + 1);
  }

  /** Controls' labels joined as a chord ("Shift + B"), named for the device's family. */
  private chordLabel(input: PlayerInput, device: UIControlMapperDevice, paths: readonly string[]): string {
    const family = device === "keyboard" ? "keyboard" : this.padFamily(input);
    return paths.map((path) => (control(path) ? controlLabel(control(path)!, family) : path)).join(this.text.chord);
  }

  private setStatus(message: string, warning = false): void {
    this.statusMessage = message;
    this.statusWarning = warning;
  }

  /** The actions listed: the `actions` field's, else every action (a set's name only when another set has it too). */
  private actionNames(): string[] {
    const listed = this.actions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (listed.length) return listed;
    // The engine's UI actions aren't the game's: listed only when named.
    const sets = actionSets().filter((s) => s.id !== UI_ACTIONS_SET);
    const count = new Map<string, number>();
    for (const s of sets) for (const a of s.actions) count.set(a.name, (count.get(a.name) ?? 0) + 1);
    return sets.flatMap((s) => s.actions.map((a) => (count.get(a.name)! > 1 ? `${s.id}:${a.name}` : a.name)));
  }

  private labelOf(action: string): string {
    const bare = action.slice(action.lastIndexOf(":") + 1);
    return this.actionLabels[action] ?? this.actionLabels[bare] ?? titleCase(bare);
  }

  /** The family the gamepad column is named for: the pad the player last used, else a paired pad's, else generic. */
  private padFamily(input: PlayerInput): DeviceFamily {
    const last = input.lastFamily;
    if (last !== "keyboard" && last !== "pointer") return last;
    for (const d of input.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad && data.connected) return familyName(data.family);
    }
    return "generic";
  }

  private promptOf(input: PlayerInput, action: string, device: UIControlMapperDevice): InputPrompt | null {
    try {
      return input.prompt(action, device === "keyboard" ? "keyboard" : this.padFamily(input));
    } catch {
      return null; // no such action: its row says so with the "none" text
    }
  }

  /** A prompt as cells: one per part for a d-pad or axis composite, else one for the whole binding. */
  private entries(prompt: InputPrompt | null): Entry[] {
    if (!prompt) return [];
    const composite = prompt.parts.length > 1 && !prompt.parts.some((p) => p === "control");
    if (composite) return prompt.parts.map((part, i) => ({ part, label: prompt.labels[i], icons: [prompt.icons[i]], controls: [prompt.controls[i]], chord: false }));
    // A chord is one cell: its label and glyphs show the whole chord, and its rebind takes the controls pressed together.
    const chord = prompt.parts.length > 1;
    return [{ part: "control", label: chord ? prompt.labels.join(this.text.chord) : prompt.label, icons: prompt.icons, controls: prompt.controls, chord }];
  }

  // --- Building ---------------------------------------------------------------------------------

  private build(world: World): Built {
    const above = canvasOf(this.node);
    const root = world._createNode("ControlMapper", this.node.entity);
    const view = root.addBehavior(UIView, { component: `asset:${CONTROL_MAPPER_COMPONENT}`, props: { model: null } });
    const built: Built = { root, view, above, rowsGeneration: 0, settingsGeneration: 0, settingsSignature: "", settings: [], unbind: null, reset: null, save: null, signature: "", rows: [], mounted: false, shown: "", anchor: null, refocusSettings: false };
    void view.ready.then(() => (built.mounted = true));
    this.copyCanvas(built);
    return built;
  }

  /**
   * The view's canvas: its own screen canvas (above the game's UI, taking focus for this player when it appears), or,
   * under a game's canvas, that canvas's settings, drawn just above it. Focus doesn't jump there: the mapper gives its
   * first cell focus unless something on the game's canvas has it.
   */
  private copyCanvas(built: Built): void {
    const v = built.view;
    const above = built.above;
    if (above?.node.isValid) {
      v.mode = above.mode;
      if (v.referenceResolution.x !== above.referenceResolution.x || v.referenceResolution.y !== above.referenceResolution.y) v.referenceResolution = above.referenceResolution.clone();
      v.matchHeight = above.matchHeight;
      v.sortOrder = above.sortOrder + 1;
      v.pixelSize = above.pixelSize;
      v.player = above.player;
      v.autoFocus = false;
      v.modal = false;
      return;
    }
    v.mode = "screen";
    v.sortOrder = 100;
    v.autoFocus = true;
    v.player = this.player;
    v.modal = this.modal;
  }

  private newCell(row: number, action: string, device: UIControlMapperDevice): CellState {
    return { action, device, label: "", icons: [], part: null, adds: false, context: null, controls: [], chord: false, conflict: false, id: `cell-${row}-${device}`, button: null };
  }

  /** Work out the rows from the player's bindings; new row states (drawn afresh) when their shape changed. */
  private syncRows(built: Built, input: PlayerInput | null): void {
    type Want = { action: string; part: string | null; label: string; keyboard: Entry | null; gamepad: Entry | null; kbContext: string | null; gpContext: string | null; kbAdds: boolean; gpAdds: boolean };
    const want: Want[] = [];
    if (input) {
      for (const action of this.actionNames()) {
        const kp = this.keyboard ? this.promptOf(input, action, "keyboard") : null;
        const gp = this.gamepad ? this.promptOf(input, action, "gamepad") : null;
        const ke = this.entries(kp);
        const ge = this.entries(gp);
        const n = Math.max(1, ke.length, ge.length);
        for (let i = 0; i < n; i++) {
          const k = ke.length > 1 || i === 0 ? (ke[i] ?? null) : null;
          const g = ge.length > 1 || i === 0 ? (ge[i] ?? null) : null;
          const part = n > 1 ? ((ke.length > 1 ? ke[i]?.part : undefined) ?? (ge.length > 1 ? ge[i]?.part : undefined) ?? null) : null;
          const name = this.labelOf(action);
          // A device with no binding at all for the action: its cell on the action's first row adds one.
          want.push({ action, part, label: part ? `${name} ${this.text.parts[part] ?? part}` : name, keyboard: k, gamepad: g, kbContext: kp?.context ?? null, gpContext: gp?.context ?? null, kbAdds: i === 0 && !kp, gpAdds: i === 0 && !gp });
        }
      }
    }
    const signature = `${this.keyboard}|${this.gamepad}|${want.map((w) => `${w.action}/${w.part}`).join(",")}`;
    if (signature !== built.signature) {
      built.signature = signature;
      // Where the focused (else the last focused) cell was, to put focus back near it once the new rows are drawn.
      const was = this.focusedCellState(built) ?? this.lastCell;
      const at = was ? built.rows.findIndex((r) => r.keyboard === was || r.gamepad === was) : -1;
      built.anchor = was && at >= 0 ? { row: at, device: was.device, focused: !!was.button?.focused } : null;
      this.lastCell = null;
      built.rowsGeneration++;
      built.rows = want.map((w, i) => ({ action: w.action, part: w.part, label: w.label, keyboard: this.keyboard ? this.newCell(i, w.action, "keyboard") : null, gamepad: this.gamepad ? this.newCell(i, w.action, "gamepad") : null }));
    }
    // Contents.
    const uses = new Map<string, number>();
    want.forEach((w, i) => {
      const r = built.rows[i];
      r.label = w.label;
      for (const [cell, entry, context, adds] of [
        [r.keyboard, w.keyboard, w.kbContext, w.kbAdds],
        [r.gamepad, w.gamepad, w.gpContext, w.gpAdds],
      ] as const) {
        if (!cell) continue;
        cell.adds = adds;
        cell.label = entry?.label ?? this.text.none;
        cell.icons = entry?.icons ?? [];
        cell.part = entry?.part ?? null;
        cell.context = entry ? context : null;
        cell.controls = entry?.controls ?? [];
        cell.chord = entry?.chord ?? false;
        if (entry && entry.controls.length === 1) {
          const key = `${cell.device}|${entry.controls[0]}`;
          uses.set(key, (uses.get(key) ?? 0) + 1);
        }
      }
    });
    for (const r of built.rows) for (const cell of [r.keyboard, r.gamepad]) if (cell) cell.conflict = cell.controls.length === 1 && (uses.get(`${cell.device}|${cell.controls[0]}`) ?? 0) > 1;
    const noPlayer = fill(this.text.noPlayer, { player: this.player });
    if (!input) this.setStatus(noPlayer, true);
    else if (this.statusMessage === noPlayer) this.setStatus("");
  }

  /** After new rows are drawn: focus the same row (or the last) in the same column, else the column's first cell that does something. */
  private placeAnchor(built: Built): void {
    const anchor = built.anchor;
    built.anchor = null;
    if (!anchor || !built.rows.length) return;
    const r = built.rows[Math.min(anchor.row, built.rows.length - 1)];
    const same = anchor.device === "keyboard" ? r.keyboard : r.gamepad;
    const cell = same && (same.part !== null || same.adds) ? same : (this.firstCell(built, anchor.device) ?? this.firstCell(built));
    this.lastCell = cell;
    if (cell?.button && anchor.focused) cell.button.focused = true;
  }

  // --- Input ------------------------------------------------------------------------------------

  /** Every button of the screen with what clicking it does, in tree order: the cells, the accessibility rows', then Unbind, Reset and Save. */
  private targets(built: Built): { button: UIButton; target: Target }[] {
    const out: { button: UIButton; target: Target }[] = [];
    built.rows.forEach((r, row) => {
      for (const cell of [r.keyboard, r.gamepad]) if (cell?.button) out.push({ button: cell.button, target: { kind: "cell", row, cell } });
    });
    for (const s of built.settings) {
      if (s.toggle) out.push({ button: s.toggle, target: { kind: "setting", column: { row: s, op: "toggle" } } });
      if (s.decrease) out.push({ button: s.decrease, target: { kind: "setting", column: { row: s, op: "decrease" } } });
      if (s.increase) out.push({ button: s.increase, target: { kind: "setting", column: { row: s, op: "increase" } } });
    }
    for (const [button, kind] of [
      [built.unbind, "unbind"],
      [built.reset, "reset"],
      [built.save, "save"],
    ] as const)
      if (button) out.push({ button, target: { kind } });
    return out;
  }

  private handleInput(built: Built, input: PlayerInput): void {
    // A click, from the pointer or from `submit` on the focused button (navigation records it as a click).
    for (const { button, target } of this.targets(built)) {
      if (!button.clicked) continue;
      this.activate(built, input, target);
      if (this.waiting) return;
    }
    // Delete and Backspace on the focused cell, from the player's own devices.
    const focused = this.focusedCellState(built);
    if (!focused) return;
    for (const e of DeviceEvents.read()) {
      if (Math.abs(e.value) < 0.5 || !UNBIND.has(e.control) || e.device.getData(InputDevice)?.player !== input.index) continue;
      this.unbindCell(input, focused);
      return;
    }
  }

  private activate(built: Built, input: PlayerInput, target: Target): void {
    switch (target.kind) {
      case "unbind": {
        const cell = this.unbindTarget(built);
        if (cell) this.unbindCell(input, cell);
        return;
      }
      case "reset":
        input.resetBindings();
        this.lastConflicts = [];
        this.setStatus(this.text.resetDone);
        return;
      case "save": {
        const n = ++this.saving;
        input.saveBindings(this.profile || undefined).then(
          () => n === this.saving && this.setStatus(this.text.saved),
          (err: unknown) => {
            console.error("[myco] UIControlMapper: saving the bindings failed:", err);
            if (n === this.saving) this.setStatus(this.text.saveFailed, true);
          },
        );
        return;
      }
      case "setting":
        if (input.player) this.changeSetting(input, target.column);
        return;
      case "cell":
        this.rebindCell(built, input, target.row, target.cell);
        return;
    }
  }

  /** Wait for the player's next press for a cell (`PlayerInput.rebind`; an empty cell adds a binding). */
  private rebindCell(built: Built, input: PlayerInput, row: number, c: CellState): void {
    if (!c.part && !c.adds) return;
    const action = built.rows[row].action;
    const timeout = this.timeout > 0 ? this.timeout : undefined;
    try {
      const options = c.part ? { device: c.device, part: c.part, context: c.context ?? undefined } : { device: c.device, add: true };
      input.rebind(action, { ...options, cancel: "<Keyboard>/escape", timeout }).catch(() => {});
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), true);
      return;
    }
    this.waiting = { action, device: c.device, cell: c, chord: c.chord };
    const waitingText = c.chord ? (c.device === "keyboard" ? this.text.waitingChordKey : this.text.waitingChordButton) : c.device === "keyboard" ? this.text.waitingKey : this.text.waitingButton;
    this.setStatus(fill(waitingText, { cancel: "Esc" }));
  }

  /** The binding cell Unbind acts on: the focused one, else the one last focused (null when that's gone). */
  private unbindTarget(built: Built): CellState | null {
    const c = this.focusedCellState(built) ?? this.lastCell;
    return c && built.rows.some((r) => r.keyboard === c || r.gamepad === c) ? c : null;
  }

  /** Remove a cell's binding (`PlayerInput.unbind`). */
  private unbindCell(input: PlayerInput, cell: CellState): void {
    if (!cell.part) return;
    const action = cell.action;
    try {
      input.unbind(action, { device: cell.device, context: cell.context ?? undefined });
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), true);
      return;
    }
    this.lastConflicts = [];
    this.setStatus(fill(this.text.unbound, { action: this.labelOf(action) }));
  }

  // --- Accessibility ----------------------------------------------------------------------------

  /** The settings rows wanted: per listed action, then repeat and the dead zone. */
  private settingRows(): { setting: UIControlMapperSettingKind; action: string | null }[] {
    if (!this.showAccessibility) return [];
    const list = (field: string) =>
      field
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    return [
      ...list(this.invertYActions).map((action) => ({ setting: "invertY" as const, action })),
      ...list(this.sensitivityActions).map((action) => ({ setting: "sensitivity" as const, action })),
      ...list(this.holdToToggleActions).map((action) => ({ setting: "holdToToggle" as const, action })),
      { setting: "repeat", action: null },
      { setting: "repeatDelay", action: null },
      { setting: "repeatInterval", action: null },
      { setting: "deadzone", action: null },
    ];
  }

  /** The accessibility rows when the list changed (drawn afresh), and each one's value from the player's settings. */
  private syncSettings(built: Built, input: PlayerInput | null): void {
    const want = input ? this.settingRows() : [];
    const signature = want.map((w) => `${w.setting}/${w.action ?? ""}`).join(",");
    if (signature !== built.settingsSignature) {
      built.settingsSignature = signature;
      // Focus on a row being removed goes back to the cells.
      if (built.settings.some((r) => [r.toggle, r.decrease, r.increase].some((b) => b?.focused))) built.refocusSettings = true;
      built.settingsGeneration++;
      built.settings = want.map((w, i) => {
        const toggle = w.setting === "invertY" || w.setting === "holdToToggle" || w.setting === "repeat";
        const ids = toggle ? { toggle: `setting-${i}-toggle`, decrease: null, increase: null } : { toggle: null, decrease: `setting-${i}-decrease`, increase: `setting-${i}-increase` };
        return { setting: w.setting, action: w.action, label: "", value: "", enabled: true, ids, toggle: null, decrease: null, increase: null };
      });
    }
    if (!input?.player) return;
    const a = input.accessibility;
    const t = this.text;
    const num = (v: number) => String(Math.round(v * 100) / 100);
    for (const r of built.settings) {
      const action = r.action ? this.labelOf(r.action) : "";
      r.enabled = true;
      switch (r.setting) {
        case "invertY":
        case "holdToToggle": {
          r.label = fill(r.setting === "invertY" ? t.invertY : t.holdToToggle, { action });
          r.value = (a[r.setting] ?? []).includes(r.action!) ? t.on : t.off;
          break;
        }
        case "repeat":
          r.label = t.repeat;
          r.value = a.repeat ? t.on : t.off;
          break;
        case "sensitivity":
          r.label = fill(t.sensitivity, { action });
          r.value = fill(t.multiplier, { value: (a.sensitivity?.[r.action!] ?? 1).toFixed(1) });
          break;
        case "repeatDelay":
        case "repeatInterval": {
          const key = r.setting === "repeatDelay" ? "delay" : "interval";
          r.label = r.setting === "repeatDelay" ? t.repeatDelay : t.repeatInterval;
          r.value = fill(t.seconds, { value: num(a.repeat?.[key] ?? this.repeatMemory[key]) });
          r.enabled = !!a.repeat;
          break;
        }
        case "deadzone":
          r.label = t.deadzone;
          r.value = fill(t.percent, { value: Math.round((a.deadzone ?? DEFAULT_STICK_DEADZONE) * 100) });
          break;
      }
    }
  }
  /** Toggle or step a setting, writing the player's accessibility (Save writes it with the bindings). */
  private changeSetting(input: PlayerInput, c: SettingColumn): void {
    const r = c.row;
    if (!r.enabled) return;
    const cur = input.accessibility;
    const next: InputAccessibility = {
      ...cur,
      ...(cur.invertY && { invertY: [...cur.invertY] }),
      ...(cur.holdToToggle && { holdToToggle: [...cur.holdToToggle] }),
      ...(cur.sensitivity && { sensitivity: { ...cur.sensitivity } }),
      ...(cur.repeat && { repeat: { ...cur.repeat } }),
    };
    const round = (v: number) => Math.round(v * 100) / 100;
    const stepped = (kind: keyof typeof STEPPERS, value: number) => {
      const { step, min, max } = STEPPERS[kind];
      return round(Math.max(min, Math.min(max, value + (c.op === "increase" ? step : -step))));
    };
    switch (r.setting) {
      case "invertY":
      case "holdToToggle": {
        const list = next[r.setting] ?? [];
        next[r.setting] = list.includes(r.action!) ? list.filter((x) => x !== r.action) : [...list, r.action!];
        break;
      }
      case "repeat":
        if (next.repeat) {
          this.repeatMemory = { delay: next.repeat.delay, interval: next.repeat.interval };
          delete next.repeat;
        } else {
          const actions = this.repeatActions
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          next.repeat = { ...this.repeatMemory, ...(actions.length && { actions }) };
        }
        break;
      case "sensitivity":
        next.sensitivity = { ...next.sensitivity, [r.action!]: stepped("sensitivity", next.sensitivity?.[r.action!] ?? 1) };
        break;
      case "repeatDelay":
        next.repeat!.delay = stepped("repeatDelay", next.repeat!.delay);
        break;
      case "repeatInterval":
        next.repeat!.interval = stepped("repeatInterval", next.repeat!.interval);
        break;
      case "deadzone":
        next.deadzone = stepped("deadzone", next.deadzone ?? DEFAULT_STICK_DEADZONE);
        break;
    }
    input.accessibility = next;
    // Shown now, not next frame: the value text follows what was just written.
    this.syncSettings(this.built!, input);
  }

  // --- Focus -------------------------------------------------------------------------------------

  /** Put focus back on the cells (the one last focused, else the first) when the button that had it stops taking it. */
  private refocus(built: Built, leaving?: UIButton): void {
    const last = this.lastCell && built.rows.some((r) => r.keyboard === this.lastCell || r.gamepad === this.lastCell) ? this.lastCell : null;
    const cell = last && last.button !== leaving && (last.part !== null || last.adds) ? last : this.firstCell(built);
    const to = cell?.button && cell.button !== leaving ? cell.button : built.reset;
    if (to) to.focused = true;
  }

  /** Set a button's `interactable`; one losing it while focused hands focus back to the cells, so a d-pad player isn't left without it. */

  /**
   * Up and down between the accessibility rows go row by row (explicit neighbours, ADR 0340): a
   * stepper's small − and + don't line up with a toggle's wide button, so the spatial search would skip
   * rows to reach the next small button straight below. A toggle goes to a stepper's −, a + to the
   * stepper's + or a toggle; disabled rows are passed over; the last row goes down to Reset. A
   * stepper's − and + go right and left to each other; leaving the section upwards is the search's.
   * Each button's neighbours, by element id.
   */
  private settingsNav(built: Built): Map<string, Nav> {
    const out = new Map<string, Nav>();
    const rows = built.settings.map((r) => (r.ids.toggle ? [r.ids.toggle] : r.enabled ? [r.ids.decrease!, r.ids.increase!] : [])).filter((b) => b.length > 0);
    for (const r of built.settings) for (const id of [r.ids.toggle, r.ids.decrease, r.ids.increase]) if (id) out.set(id, { up: null, down: null, left: null, right: null });
    rows.forEach((ids, i) =>
      ids.forEach((id, column) => {
        const above = rows[i - 1];
        const below = rows[i + 1];
        const nav = out.get(id)!;
        nav.up = above ? above[Math.min(column, above.length - 1)] : null;
        nav.down = below ? below[Math.min(column, below.length - 1)] : "reset";
      }),
    );
    // A stepper's − and + are each other's neighbours across its value (else a wide toggle nearby can be nearer).
    for (const r of built.settings) {
      if (!r.ids.decrease || !r.ids.increase) continue;
      out.get(r.ids.decrease)!.right = r.ids.increase;
      out.get(r.ids.increase)!.left = r.ids.decrease;
    }
    return out;
  }

  /** What the view draws: everything as plain data, its look from the mapper's fields. */
  private model(built: Built): ViewModel {
    const t = this.text;
    const cell = (c: CellState | null): ViewCell | null => {
      if (!c) return null;
      const waiting = this.waiting?.cell === c;
      const pressText = c.chord ? (c.device === "keyboard" ? t.pressChordKey : t.pressChordButton) : c.device === "keyboard" ? t.pressKey : t.pressButton;
      const glyphs = waiting ? [] : c.icons.map((k) => InputGlyphs.get(k)).filter((g) => g !== null).map((g) => ({ asset: g.asset, width: g.width, height: g.height }));
      // A cell with nothing to rebind or add isn't interactable, so navigation skips it.
      return { id: c.id, label: waiting ? pressText : c.label, glyphs, tone: waiting ? "text" : c.conflict ? "warning" : c.part ? "text" : "muted", waiting, interactable: c.part !== null || c.adds };
    };
    const side = (id: string | null, interactable: boolean) => (id ? { id, interactable } : null);
    const unbindable = this.unbindTarget(built)?.part != null;
    const w = String(this.width).trim();
    return {
      title: this.title,
      headers: { action: t.action, keyboard: this.keyboard ? t.keyboard : null, gamepad: this.gamepad ? t.gamepad : null },
      rows: built.rows.map((r, i) => ({ key: `${built.rowsGeneration}-${i}`, label: r.label, keyboard: cell(r.keyboard), gamepad: cell(r.gamepad) })),
      accessibility: built.settings.length > 0 ? t.accessibility : null,
      settings: built.settings.map((s, i) => ({ key: `${built.settingsGeneration}-${i}`, label: s.label, value: s.value, enabled: s.enabled, toggle: side(s.ids.toggle, true), decrease: side(s.ids.decrease, s.enabled), increase: side(s.ids.increase, s.enabled) })),
      decrease: t.decrease,
      increase: t.increase,
      status: this.statusMessage,
      statusWarning: this.statusWarning,
      unbind: { label: t.unbind, enabled: unbindable },
      reset: t.reset,
      save: t.save,
      focus: this.focusedId(built),
      look: {
        width: /^-?\d+(\.\d+)?$/.test(w) ? `${w}px` : w,
        fontSize: this.fontSize,
        glyphSize: this.glyphSize,
        colors: { background: css(this.backgroundColor), cell: css(this.cellColor), hover: css(this.hoverColor), pressed: css(this.pressedColor), accent: css(this.accentColor), text: css(this.textColor), muted: css(this.mutedColor), warning: css(this.warningColor) },
      },
    };
  }

  /** The id of the screen's button that has focus, or null. */
  private focusedId(built: Built): string | null {
    for (const r of built.rows) for (const c of [r.keyboard, r.gamepad]) if (c?.button?.focused) return c.id;
    for (const s of built.settings) for (const k of ["toggle", "decrease", "increase"] as const) if (s[k]?.focused) return s.ids[k];
    for (const k of ["unbind", "reset", "save"] as const) if (built[k]?.focused) return k;
    return null;
  }

  /**
   * Pass the model to the view when it changed and draw it now, then find the rendered buttons. A button that stops
   * being interactable while focused hands focus back to the cells, so a d-pad player isn't left without it.
   */
  private render(built: Built): void {
    const model = this.model(built);
    const json = JSON.stringify(model);
    if (json === built.shown) return;
    built.shown = json;
    const view = built.view;
    view.props.model = model;
    view._flush();
    const at = (id: string | null) => (id ? (view.query(`#${id}`)?.as(UIButton) ?? null) : null);
    for (const r of built.rows) for (const c of [r.keyboard, r.gamepad]) if (c) c.button = at(c.id);
    for (const s of built.settings) {
      s.toggle = at(s.ids.toggle);
      s.decrease = at(s.ids.decrease);
      s.increase = at(s.ids.increase);
    }
    built.unbind = at("unbind");
    built.reset = at("reset");
    built.save = at("save");
    for (const [id, nav] of this.settingsNav(built)) {
      const b = at(id);
      if (!b) continue;
      const node = (to: string | null) => (to ? (at(to)?.node ?? null) : null);
      b.navUp = node(nav.up);
      b.navDown = node(nav.down);
      b.navLeft = node(nav.left);
      b.navRight = node(nav.right);
    }
    this.placeAnchor(built);
    if (built.refocusSettings) {
      built.refocusSettings = false;
      this.refocus(built);
    }
    const off: (UIButton | null)[] = [];
    built.rows.forEach((r, i) => {
      if (r.keyboard && !model.rows[i].keyboard!.interactable) off.push(r.keyboard.button);
      if (r.gamepad && !model.rows[i].gamepad!.interactable) off.push(r.gamepad.button);
    });
    built.settings.forEach((s, i) => {
      if (model.settings[i].decrease?.interactable === false) off.push(s.decrease, s.increase);
    });
    if (!model.unbind.enabled) off.push(built.unbind);
    for (const b of off) if (b?.focused) this.refocus(built, b);
  }

}

/** Its CSS colour, exact for the colour fields' values (percentages keep two-decimal channels as they are). */
function css(c: Color): string {
  return `rgba(${c.r * 100}%, ${c.g * 100}%, ${c.b * 100}%, ${c.a})`;
}

/** The UICanvas at or above a node, or null. */
function canvasOf(node: GameObject): UICanvas | null {
  for (let n: GameObject | null = node; n?.isValid; n = n.parent) {
    const c = n.getComponent(UICanvas);
    if (c) return c;
  }
  return null;
}

function cellView(c: CellState): UIControlMapperCell {
  return { action: c.action, device: c.device, label: c.label, icons: [...c.icons], part: c.part, adds: c.adds, chord: c.chord, conflict: c.conflict, button: c.button! };
}

function mappersOf(world: World): UIControlMapper[] {
  return [...live].filter((m) => m.node.isValid && m._world === world);
}

// After the UI's events (so clicks are read the frame scripts see them) and before behaviors' update.
defineBuiltinSystem({ name: "engine.UIControlMapper", phase: "update", after: ["engine.UIDocumentEvents", "engine.UIHostEvents", "engine.InputFrame"], before: ["engine.UpdateScripts"], run: (w) => mappersOf(w).forEach((m) => m._frame(w)) });
