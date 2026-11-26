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
 * It is made of built-in UI documents (ADR 0417: game UI comes only from documents): the screen
 * (`@myco/ui/control-mapper.ui.xml`, or `control-mapper-canvas.ui.xml` with a screen canvas of its
 * own when there's no `UICanvas` above it), one per row, cell and accessibility row, built under the
 * screen's `#Rows` and `#Settings` as the player's bindings call for them. Their nodes belong to it:
 * they aren't in the scene file and go when it does.
 */
import { Component } from "../core/Component";
import { Color } from "../core/math";
import { component, field, getComponentClass } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { actionSets } from "../input/actions";
import { DEFAULT_CONTEXT } from "../input/contexts";
import { control, type DeviceFamily } from "../input/controls";
import { DeviceEvents, DeviceKind, InputDevice } from "../input/deviceEntities";
import { DEFAULT_STICK_DEADZONE } from "../input/evaluate";
import { InputPlayers, type PlayerInput } from "../input/facade";
import { InputGlyphs } from "../input/glyphs";
import { familyName } from "../input/players";
import type { InputAccessibility } from "../input/profiles";
import { controlLabel, type InputPrompt } from "../input/prompts";
import { RebindResults, type RebindResult } from "../input/rebind";
import { Assets } from "../scene/Assets";
import { UIButton, UICanvas, UIImage, UIPanel, UIText, type UILength } from "./components";
import { uiInteractions } from "./interactions";
import { UIDocument, loadUIDocumentSupport, type UIDocumentElement } from "./UIDocument";

/** The words a control mapper shows, for translating. */
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
  button: UIButton;
  text: UIText;
  images: UIImage[];
}

interface SettingState {
  /** The row document's node. */
  host: GameObject;
  setting: UIControlMapperSettingKind;
  action: string | null;
  label: string;
  value: string;
  enabled: boolean;
  name: UIText;
  valueText: UIText | null;
  toggle: UIButton | null;
  toggleText: UIText | null;
  decrease: UIButton | null;
  decreaseText: UIText | null;
  increase: UIButton | null;
  increaseText: UIText | null;
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
  /** The row document's node. */
  host: GameObject;
  action: string;
  part: string | null;
  label: string;
  name: UIText;
  keyboard: CellState | null;
  gamepad: CellState | null;
}

interface Built {
  root: GameObject;
  /** The canvas it draws on: its own, or the one above it. */
  canvas: UICanvas;
  /** True when it made `canvas`. */
  ownCanvas: boolean;
  panel: UIPanel;
  title: UIText;
  headerKeyboard: UIText;
  headerGamepad: UIText;
  headerAction: UIText;
  list: UIPanel;
  settingsHeading: UIText;
  settingsList: UIPanel;
  settingsSignature: string;
  settings: SettingState[];
  status: UIText;
  unbind: UIButton;
  unbindText: UIText;
  reset: UIButton;
  resetText: UIText;
  save: UIButton;
  saveText: UIText;
  signature: string;
  rows: RowState[];
}

const IMAGES_PER_CELL = 3;

/** The built-in documents the screen is built from (ADR 0417), as `@myco/ui/<name>.ui.xml`. */
const DOCUMENT_DIR = "@myco/ui/";
const label = (id: string) => `<Text id="${id}Label"/>`;
const SCREEN = `<Panel id="Screen" width="100%" height="100%" justify-content="center" align-items="center">
  <Panel id="Panel" flex-direction="column" padding="24" gap="10" border-radius="12">
    <Text id="Title" font-weight="bold"/>
    <Panel id="Header" gap="8" align-items="center">
      <Text id="Action" width="34%"/>
      <Text id="Keyboard" flex-grow="1" width="0"/>
      <Text id="Gamepad" flex-grow="1" width="0"/>
    </Panel>
    <Panel id="Rows" flex-direction="column" gap="6"/>
    <Text id="Accessibility" font-weight="bold" display="none"/>
    <Panel id="Settings" flex-direction="column" gap="6" display="none"/>
    <Text id="Status"/>
    <Panel id="Buttons" gap="8" justify-content="flex-end">
      <Button id="Unbind" border-width="2">${label("Unbind")}</Button>
      <Button id="Reset" border-width="2">${label("Reset")}</Button>
      <Button id="Save" border-width="2">${label("Save")}</Button>
    </Panel>
  </Panel>
</Panel>`;
const cell = (id: string) =>
  `<Button id="${id}" flex-grow="1" width="0" padding="6" gap="8" justify-content="flex-start" border-width="2">${'<Image display="none"/>'.repeat(IMAGES_PER_CELL)}<Text id="Label" word-break="keep-all"/></Button>`;
const side = (id: string) => `<Button id="${id}" justify-content="center" align-items="center" border-width="2">${label(id)}</Button>`;
const DOCUMENTS: Record<string, string> = {
  "control-mapper": SCREEN,
  "control-mapper-canvas": `<Canvas id="Canvas" sort-order="100" auto-focus>${SCREEN}</Canvas>`,
  "control-mapper-row": `<Panel id="Row" gap="8" align-items="center"><Text id="Name" width="34%"/></Panel>`,
  "control-mapper-keyboard": cell("Keyboard"),
  "control-mapper-gamepad": cell("Gamepad"),
  "control-mapper-toggle": `<Panel id="Setting" gap="8" align-items="center"><Text id="Name" width="34%"/><Button id="Toggle" flex-grow="1" width="0" padding="6" justify-content="center" align-items="center" border-width="2">${label("Toggle")}</Button></Panel>`,
  "control-mapper-stepper": `<Panel id="Setting" gap="8" align-items="center"><Text id="Name" width="34%"/>${side("Decrease")}<Text id="Value" flex-grow="1" width="0" text-align="center"/>${side("Increase")}</Panel>`,
};
const documentPath = (name: string) => `${DOCUMENT_DIR}${name}.ui.xml`;
Assets.addBuiltinSource({
  has: (path) => path.startsWith(DOCUMENT_DIR) && path.endsWith(".ui.xml") && path.slice(DOCUMENT_DIR.length, -7) in DOCUMENTS,
  get: (path) => DOCUMENTS[path.slice(DOCUMENT_DIR.length, -7)],
});

/** Whether the document parsers have loaded (they load the first time a mapper needs them). */
let documentSupport: "none" | "loading" | "ready" = "none";
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
 * A rebinding screen for one player: put it on a node under a UI document's `<Canvas>` (or anywhere:
 * it makes a screen canvas of its own). Rows list the actions (`actions`, or every defined action), one per
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

  /** @internal Read the player's bindings, handle clicks, presses and rebind results, and update the elements. */
  _frame(world: World): void {
    if (getComponentClass("engine.UIPanel") !== UIPanel) {
      // The UI plugin is off (ADR 0140): there are no UI elements to build.
      if (!warnedNoUI) console.warn("[myco] UIControlMapper needs the UI plugin, which is disabled.");
      warnedNoUI = true;
      return;
    }
    if (documentSupport !== "ready") {
      // Built from UI documents (ADR 0417): wait for their parsers, loaded once.
      if (documentSupport === "none") {
        documentSupport = "loading";
        loadUIDocumentSupport().then(
          () => (documentSupport = "ready"),
          (err: unknown) => {
            documentSupport = "none";
            console.error("[myco] UIControlMapper couldn't load the UI document parsers:", err);
          },
        );
      }
      return;
    }
    const input = InputPlayers.get(this.player);
    const built = (this.built ??= this.build(world));
    const finished = input ? this.collectResults(input) : false;
    this.syncRows(world, built, input);
    this.syncSettings(world, built, input);
    this.giveFocus(world, built);
    this.noteFocusedCell(built);
    if (input && !this.waiting && !finished) this.handleInput(built, input);
    this.noteFocusedCell(built);
    this.paint(built);
  }

  /** Under a game's canvas, focus the first cell once the rows are there, unless something on that canvas has focus (its own canvas does this with `autoFocus`). */
  private giveFocus(world: World, built: Built): void {
    if (built.ownCanvas || this.focusGiven || !built.rows.length) return;
    this.focusGiven = true;
    const focused = uiInteractions(world).focused;
    if (focused?.node.isValid && focused.isActiveAndEnabled && canvasOf(focused.owner) === built.canvas) return;
    const first = this.firstCell(built);
    if (first) first.button.focused = true;
  }

  /** Remember the focused binding cell: what Unbind acts on once focus has moved to the button. */
  private noteFocusedCell(built: Built): void {
    const c = this.focusedCellState(built);
    if (c) this.lastCell = c;
  }

  /** The binding cell that has focus, or null. */
  private focusedCellState(built: Built): CellState | null {
    for (const r of built.rows) for (const c of [r.keyboard, r.gamepad]) if (c?.button.focused) return c;
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

  /** Build the built-in document `name` on a new node `host` under `parent`; returns its root element. */
  private document(world: World, parent: GameObject, host: string, name: string): UIDocumentElement {
    const node = world._createNode(host, parent.entity);
    const root = node.addBehavior(UIDocument, { document: `asset:${documentPath(name)}` }).root;
    if (!root) throw new Error(`UIControlMapper: the built-in document "${documentPath(name)}" didn't build.`);
    return root;
  }

  private build(world: World): Built {
    const above = canvasOf(this.node);
    // A full-size box that centres the panel: in the canvas above, else in a screen canvas of its own,
    // which takes focus when it appears (ADR 0340) and is driven by this player's UI actions.
    const top = this.document(world, this.node, "ControlMapper", above ? "control-mapper" : "control-mapper-canvas");
    const root = top.node.parent!;
    const at = <T extends UIText | UIPanel | UIButton>(id: string, type: abstract new () => T): T => top.query(`#${id}`)!.as(type);
    const canvas = above ?? top.as(UICanvas);
    if (!above) {
      canvas.player = this.player;
      canvas.modal = this.modal;
    }
    return {
      root,
      canvas,
      ownCanvas: !above,
      panel: at("Panel", UIPanel),
      title: at("Title", UIText),
      headerAction: at("Action", UIText),
      headerKeyboard: at("Keyboard", UIText),
      headerGamepad: at("Gamepad", UIText),
      list: at("Rows", UIPanel),
      settingsHeading: at("Accessibility", UIText),
      settingsList: at("Settings", UIPanel),
      settingsSignature: "",
      settings: [],
      status: at("Status", UIText),
      unbind: at("Unbind", UIButton),
      unbindText: at("UnbindLabel", UIText),
      reset: at("Reset", UIButton),
      resetText: at("ResetLabel", UIText),
      save: at("Save", UIButton),
      saveText: at("SaveLabel", UIText),
      signature: "",
      rows: [],
    };
  }

  private buildCell(world: World, row: GameObject, action: string, device: UIControlMapperDevice): CellState {
    const el = this.document(world, row, device === "keyboard" ? "Keyboard" : "Gamepad", `control-mapper-${device}`);
    const button = el.as(UIButton);
    button.height = (this.glyphSize + 14) as UILength;
    const images = el.queryAll("Image").map((i) => i.as(UIImage));
    const text = el.query("Text")!.as(UIText);
    return { action, device, label: "", icons: [], part: null, adds: false, context: null, controls: [], chord: false, conflict: false, button, text, images };
  }

  /** Work out the rows from the player's bindings; rebuild the row elements when their shape changed. */
  private syncRows(world: World, built: Built, input: PlayerInput | null): void {
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
    // Where the focused (else the last focused) cell was, to put focus back near it when the rows are rebuilt.
    let anchor: { row: number; device: UIControlMapperDevice; focused: boolean } | null = null;
    if (signature !== built.signature) {
      built.signature = signature;
      const was = this.focusedCellState(built) ?? this.lastCell;
      const at = was ? built.rows.findIndex((r) => r.keyboard === was || r.gamepad === was) : -1;
      if (was && at >= 0) anchor = { row: at, device: was.device, focused: was.button.focused };
      this.lastCell = null;
      for (const r of built.rows) if (r.host.isValid) world._destroyNode(r.host.entity);
      built.rows = want.map((w, i) => {
        const row = this.document(world, built.list.node, `Row${i}`, "control-mapper-row");
        const name = row.query("#Name")!.as(UIText);
        return { host: row.node.parent!, action: w.action, part: w.part, label: w.label, name, keyboard: this.keyboard ? this.buildCell(world, row.node, w.action, "keyboard") : null, gamepad: this.gamepad ? this.buildCell(world, row.node, w.action, "gamepad") : null };
      });
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
    if (anchor && built.rows.length) {
      // The same row (or the last) in the same column, else the column's first cell that does something.
      const r = built.rows[Math.min(anchor.row, built.rows.length - 1)];
      const same = anchor.device === "keyboard" ? r.keyboard : r.gamepad;
      const cell = same && (same.part !== null || same.adds) ? same : (this.firstCell(built, anchor.device) ?? this.firstCell(built));
      this.lastCell = cell;
      if (cell && anchor.focused) cell.button.focused = true;
    }
    const noPlayer = fill(this.text.noPlayer, { player: this.player });
    if (!input) this.setStatus(noPlayer, true);
    else if (this.statusMessage === noPlayer) this.setStatus("");
  }

  // --- Input ------------------------------------------------------------------------------------

  /** Every button of the screen with what clicking it does, in tree order: the cells, the accessibility rows', then Unbind, Reset and Save. */
  private targets(built: Built): { button: UIButton; target: Target }[] {
    const out: { button: UIButton; target: Target }[] = [];
    built.rows.forEach((r, row) => {
      for (const cell of [r.keyboard, r.gamepad]) if (cell) out.push({ button: cell.button, target: { kind: "cell", row, cell } });
    });
    for (const s of built.settings) {
      if (s.toggle) out.push({ button: s.toggle, target: { kind: "setting", column: { row: s, op: "toggle" } } });
      if (s.decrease) out.push({ button: s.decrease, target: { kind: "setting", column: { row: s, op: "decrease" } } });
      if (s.increase) out.push({ button: s.increase, target: { kind: "setting", column: { row: s, op: "increase" } } });
    }
    out.push({ button: built.unbind, target: { kind: "unbind" } }, { button: built.reset, target: { kind: "reset" } }, { button: built.save, target: { kind: "save" } });
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

  private buildSetting(world: World, parent: GameObject, index: number, setting: UIControlMapperSettingKind, action: string | null): SettingState {
    const toggle = setting === "invertY" || setting === "holdToToggle" || setting === "repeat";
    const row = this.document(world, parent, `Setting${index}`, toggle ? "control-mapper-toggle" : "control-mapper-stepper");
    const at = <T extends UIText | UIButton>(id: string, type: abstract new () => T): T | null => row.query(`#${id}`)?.as(type) ?? null;
    const height = (this.glyphSize + 14) as UILength;
    const state: SettingState = {
      host: row.node.parent!,
      setting,
      action,
      label: "",
      value: "",
      enabled: true,
      name: at("Name", UIText)!,
      valueText: at("Value", UIText),
      toggle: at("Toggle", UIButton),
      toggleText: at("ToggleLabel", UIText),
      decrease: at("Decrease", UIButton),
      decreaseText: at("DecreaseLabel", UIText),
      increase: at("Increase", UIButton),
      increaseText: at("IncreaseLabel", UIText),
    };
    if (state.toggle) state.toggle.height = height;
    for (const b of [state.decrease, state.increase]) {
      if (!b) continue;
      b.width = height;
      b.height = height;
    }
    return state;
  }

  /** Build the accessibility rows when the list changed, and show each one's value from the player's settings. */
  private syncSettings(world: World, built: Built, input: PlayerInput | null): void {
    const want = input ? this.settingRows() : [];
    const signature = want.map((w) => `${w.setting}/${w.action ?? ""}`).join(",");
    if (signature !== built.settingsSignature) {
      built.settingsSignature = signature;
      // Focus on a row being removed goes back to the cells.
      const hadFocus = built.settings.some((r) => [r.toggle, r.decrease, r.increase].some((b) => b?.focused));
      for (const r of built.settings) if (r.host.isValid) world._destroyNode(r.host.entity);
      built.settings = want.map((w, i) => this.buildSetting(world, built.settingsList.node, i, w.setting, w.action));
      if (hadFocus) this.refocus(built);
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
    this.syncSettings(this._world, this.built!, input);
  }

  // --- Focus -------------------------------------------------------------------------------------

  /** Put focus back on the cells (the one last focused, else the first) when the button that had it stops taking it. */
  private refocus(built: Built, leaving?: UIButton): void {
    const last = this.lastCell && built.rows.some((r) => r.keyboard === this.lastCell || r.gamepad === this.lastCell) ? this.lastCell : null;
    const cell = last && last.button !== leaving && (last.part !== null || last.adds) ? last : this.firstCell(built);
    const to = cell && cell.button !== leaving ? cell.button : built.reset;
    to.focused = true;
  }

  /** Set a button's `interactable`; one losing it while focused hands focus back to the cells, so a d-pad player isn't left without it. */
  private setInteractable(built: Built, b: UIButton, value: boolean): void {
    if (b.interactable === value) return;
    b.interactable = value;
    if (!value && b.focused) this.refocus(built, b);
  }

  /**
   * Up and down between the accessibility rows go row by row (explicit neighbours, ADR 0340): a
   * stepper's small − and + don't line up with a toggle's wide button, so the spatial search would skip
   * rows to reach the next small button straight below. A toggle goes to a stepper's −, a + to the
   * stepper's + or a toggle; disabled rows are passed over; the last row goes down to Reset. A
   * stepper's − and + go right and left to each other; leaving the section upwards is the search's.
   */
  private wireSettings(built: Built): void {
    const rows = built.settings.map((r) => (r.toggle ? [r.toggle] : r.enabled ? [r.decrease!, r.increase!] : [])).filter((b) => b.length > 0);
    rows.forEach((buttons, i) =>
      buttons.forEach((b, column) => {
        const above = rows[i - 1];
        const below = rows[i + 1];
        b.navUp = above ? above[Math.min(column, above.length - 1)].node : null;
        b.navDown = below ? below[Math.min(column, below.length - 1)].node : built.reset.node;
      }),
    );
    // A stepper's − and + are each other's neighbours across its value (else a wide toggle nearby can be nearer).
    for (const r of built.settings) {
      if (!r.decrease || !r.increase) continue;
      r.decrease.navRight = r.increase.node;
      r.increase.navLeft = r.decrease.node;
    }
  }

  // --- Drawing ----------------------------------------------------------------------------------

  private paint(built: Built): void {
    if (built.ownCanvas) {
      built.canvas.player = this.player;
      built.canvas.modal = this.modal;
    }
    const size = this.fontSize;
    const text = (t: UIText, value: string, colour = this.textColor, fontSize = size) => {
      if (t.text !== value) t.text = value;
      t.fontSize = fontSize;
      t.color = colour;
    };
    built.panel.backgroundColor = this.backgroundColor;
    built.panel.width = this.width;
    text(built.title, this.title, this.textColor, Math.round(size * 1.5));
    text(built.headerAction, this.text.action, this.mutedColor);
    text(built.headerKeyboard, this.text.keyboard, this.mutedColor);
    text(built.headerGamepad, this.text.gamepad, this.mutedColor);
    built.headerKeyboard.display = this.keyboard ? "flex" : "none";
    built.headerGamepad.display = this.gamepad ? "flex" : "none";
    text(built.status, this.statusMessage, this.statusWarning ? this.warningColor : this.mutedColor);
    built.status.display = this.statusMessage ? "flex" : "none";
    for (const r of built.rows) {
      text(r.name, r.label);
      for (const cell of [r.keyboard, r.gamepad]) {
        if (!cell) continue;
        const waiting = this.waiting?.cell === cell;
        this.styleButton(cell.button, waiting);
        const pressText = cell.chord ? (cell.device === "keyboard" ? this.text.pressChordKey : this.text.pressChordButton) : cell.device === "keyboard" ? this.text.pressKey : this.text.pressButton;
        const label = waiting ? pressText : cell.label;
        text(cell.text, label, waiting ? this.textColor : cell.conflict ? this.warningColor : cell.part ? this.textColor : this.mutedColor);
        // A cell with nothing to rebind or add isn't interactable, so navigation skips it.
        this.setInteractable(built, cell.button, cell.part !== null || cell.adds);
        const glyphs = waiting ? [] : cell.icons.map((k) => InputGlyphs.get(k)).filter((g) => g !== null);
        cell.images.forEach((img, i) => {
          const g = glyphs[i];
          img.display = g ? "flex" : "none";
          if (!g) return;
          if (img.image !== g.asset) img.image = g.asset;
          img.height = this.glyphSize;
          img.width = Math.round((this.glyphSize * g.width) / g.height);
        });
      }
    }
    const showSettings = built.settings.length > 0;
    built.settingsHeading.display = showSettings ? "flex" : "none";
    built.settingsList.display = showSettings ? "flex" : "none";
    text(built.settingsHeading, showSettings ? this.text.accessibility : "", this.textColor, Math.round(size * 1.2));
    for (const r of built.settings) {
      text(r.name, r.label);
      const colour = r.enabled ? this.textColor : this.mutedColor;
      if (r.toggle) {
        this.styleButton(r.toggle, false);
        text(r.toggleText!, r.value, colour);
      } else {
        this.styleButton(r.decrease!, false);
        this.styleButton(r.increase!, false);
        this.setInteractable(built, r.decrease!, r.enabled);
        this.setInteractable(built, r.increase!, r.enabled);
        text(r.decreaseText!, this.text.decrease, colour);
        text(r.increaseText!, this.text.increase, colour);
        text(r.valueText!, r.value, colour);
      }
    }
    this.wireSettings(built);
    this.styleButton(built.unbind, false);
    this.styleButton(built.reset, false);
    this.styleButton(built.save, false);
    const unbindable = this.unbindTarget(built)?.part != null;
    this.setInteractable(built, built.unbind, unbindable);
    text(built.unbindText, this.text.unbind, unbindable ? this.textColor : this.mutedColor);
    text(built.resetText, this.text.reset);
    text(built.saveText, this.text.save);
  }

  /** A button's colours: the accent border while it has focus (after mouse use too: Delete, Backspace and Unbind act on what has focus), the accent fill while it waits for a press. */
  private styleButton(b: UIButton, waiting: boolean): void {
    b.backgroundColor = waiting ? this.accentColor : this.cellColor;
    b.hoverColor = waiting ? this.accentColor : this.hoverColor;
    b.pressedColor = this.pressedColor;
    b.focusColor = waiting ? this.accentColor : this.hoverColor;
    b.borderColor = b.focused || waiting ? this.accentColor : this.cellColor;
  }
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
  return { action: c.action, device: c.device, label: c.label, icons: [...c.icons], part: c.part, adds: c.adds, chord: c.chord, conflict: c.conflict, button: c.button };
}

function mappersOf(world: World): UIControlMapper[] {
  return [...live].filter((m) => m.node.isValid && m._world === world);
}

// After the UI documents' events (so clicks are read the frame scripts see them) and before behaviors' update.
defineBuiltinSystem({ name: "engine.UIControlMapper", phase: "update", after: ["engine.UIDocumentEvents", "engine.InputFrame"], before: ["engine.UpdateScripts"], run: (w) => mappersOf(w).forEach((m) => m._frame(w)) });
