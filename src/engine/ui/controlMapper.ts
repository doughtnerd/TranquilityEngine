/**
 * A ready-made rebinding screen (ADR 0337, Rewired's Control Mapper): `UIControlMapper` builds a
 * panel of UI elements as its node's children listing a player's actions with their keyboard and
 * gamepad bindings (glyph and label, following the device family the player last used), and
 * rebinds the one the player clicks or confirms through `PlayerInput.rebind`, reports conflicts,
 * resets to the defaults and saves with `saveBindings`. Mouse, keyboard (arrows, Enter) and gamepad
 * (d-pad, south button) all drive it.
 *
 * Like a UI document's elements, the nodes it builds belong to it: they aren't in the scene file
 * and go when it does. Without a `UICanvas` above it, it makes its own screen canvas.
 */
import { Component } from "../core/Component";
import { Color } from "../core/math";
import { component, field, getComponentClass } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { actionSets } from "../input/actions";
import { DEFAULT_CONTEXT } from "../input/contexts";
import type { DeviceFamily } from "../input/controls";
import { DeviceEvents, DeviceKind, InputDevice } from "../input/deviceEntities";
import { InputPlayers, type PlayerInput } from "../input/facade";
import { InputGlyphs } from "../input/glyphs";
import { familyName } from "../input/players";
import type { InputPrompt } from "../input/prompts";
import { RebindResults, type RebindResult } from "../input/rebind";
import { UIButton, UICanvas, UIImage, UIPanel, UIText, type UIComponentType, type UILength } from "./components";

/** The words a control mapper shows, for translating. */
export interface UIControlMapperText {
  keyboard: string;
  gamepad: string;
  action: string;
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
  resetDone: string;
  saved: string;
  saveFailed: string;
  noPlayer: string;
  /** Part names of composite bindings, after the action's name ("Move Up"). */
  parts: Record<string, string>;
}

const DEFAULT_TEXT: UIControlMapperText = {
  keyboard: "Keyboard",
  gamepad: "Gamepad",
  action: "Action",
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
  resetDone: "Bindings reset to the defaults.",
  saved: "Saved.",
  saveFailed: "Couldn't save the bindings.",
  noPlayer: "There's no player {player}.",
  parts: { up: "Up", down: "Down", left: "Left", right: "Right", negative: "−", positive: "+" },
};

/** A device column. */
export type UIControlMapperDevice = "keyboard" | "gamepad";

/** One binding cell: what it shows and the button that rebinds it. */
export interface UIControlMapperCell {
  readonly device: UIControlMapperDevice;
  /** The control's label ("Space", "A", "Shift+B"), or the `none` text when the device has no binding. */
  readonly label: string;
  /** The glyphs' icon keys. */
  readonly icons: readonly string[];
  /** The rebind part (`control`, `up`…), or null when there's nothing to rebind. */
  readonly part: string | null;
  /** True when another listed action's binding for this device uses the same control. */
  readonly conflict: boolean;
  /** The button: click it (or select it and press Enter) to rebind. */
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

interface Entry {
  readonly part: string;
  readonly label: string;
  readonly icons: readonly string[];
  readonly controls: readonly string[];
}

interface CellState {
  device: UIControlMapperDevice;
  label: string;
  icons: readonly string[];
  part: string | null;
  context: string | null;
  controls: readonly string[];
  conflict: boolean;
  button: UIButton;
  text: UIText;
  images: UIImage[];
}

interface RowState {
  action: string;
  part: string | null;
  label: string;
  name: UIText;
  keyboard: CellState | null;
  gamepad: CellState | null;
}

interface Built {
  root: GameObject;
  panel: UIPanel;
  title: UIText;
  headerKeyboard: UIText;
  headerGamepad: UIText;
  headerAction: UIText;
  list: UIPanel;
  status: UIText;
  reset: UIButton;
  resetText: UIText;
  save: UIButton;
  saveText: UIText;
  signature: string;
  rows: RowState[];
}

const IMAGES_PER_CELL = 3;
const NAV_DIRS: Record<string, "up" | "down" | "left" | "right"> = {
  "<Keyboard>/arrowup": "up",
  "<Keyboard>/arrowdown": "down",
  "<Keyboard>/arrowleft": "left",
  "<Keyboard>/arrowright": "right",
  "<Gamepad>/dpadUp": "up",
  "<Gamepad>/dpadDown": "down",
  "<Gamepad>/dpadLeft": "left",
  "<Gamepad>/dpadRight": "right",
};
const CONFIRM = new Set(["<Keyboard>/enter", "<Gamepad>/buttonSouth"]);

const live = new Set<UIControlMapper>();
let warnedNoUI = false;

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
/** "jumpHigh" → "Jump High". */
const titleCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * A rebinding screen for one player: put it on a node under a `UICanvas` (or anywhere: it makes a
 * screen canvas of its own). Rows list the actions (`actions`, or every defined action), one per
 * part for a composite binding (Move Up, Move Down…), with a keyboard and a gamepad cell. Clicking
 * a cell, or selecting it with the arrows or d-pad and pressing Enter or the south button, waits
 * for the player's next press (`PlayerInput.rebind`; Escape cancels) and shows any conflict.
 * **Reset to defaults** drops the overrides; **Save** writes them with `saveBindings`.
 */
@component("engine.UIControlMapper")
export class UIControlMapper extends Component {
  /** The player's index. */
  @field(Number) player = 0;
  /** The actions to list, comma-separated (`"jump, move, game.Vehicle:honk"`); empty lists every action of every action set. */
  @field(String) actions = "";
  /** Show the keyboard (and mouse) column. */
  @field(Boolean) keyboard = true;
  /** Show the gamepad column. */
  @field(Boolean) gamepad = true;
  /** Profile name for `saveBindings` (empty: `player<index>`). */
  @field(String) profile = "";
  /** Seconds to wait for a press before giving up (0: wait until a press or Escape). */
  @field(Number) timeout = 10;
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
  /** The selected cell's border, and the cell waiting for a press. */
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
  private selection = { row: 0, column: 0 };
  private waiting: { action: string; device: UIControlMapperDevice; rowIndex: number; column: number } | null = null;
  private statusMessage = "";
  private statusWarning = false;
  private lastConflicts: readonly string[] = [];
  private saving = 0;

  // --- What scripts read ------------------------------------------------------------------------

  /** The rows as last shown (empty before the first frame). */
  get rows(): readonly UIControlMapperRow[] {
    return (this.built?.rows ?? []).map((r) => ({ action: r.action, part: r.part, label: r.label, keyboard: r.keyboard && cellView(r.keyboard), gamepad: r.gamepad && cellView(r.gamepad) }));
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

  /** The selected cell: a row index (`rows.length` is the button row) and a column (0: the first shown). */
  get selected(): { readonly row: number; readonly column: number } {
    return { ...this.selection };
  }

  /** The Reset and Save buttons (null before the first frame). */
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
    const input = InputPlayers.get(this.player);
    const built = (this.built ??= this.build(world));
    const finished = input ? this.collectResults(input) : false;
    this.syncRows(world, built, input);
    if (input && !this.waiting && !finished) this.handleInput(built, input);
    this.paint(built);
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
    const label = this.controlLabel(input, w.action, w.device, result.control);
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
    const sets = actionSets();
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
    if (composite) return prompt.parts.map((part, i) => ({ part, label: prompt.labels[i], icons: [prompt.icons[i]], controls: [prompt.controls[i]] }));
    // A chord rebinds its main control; its label and glyphs show the whole chord.
    return [{ part: "control", label: prompt.label, icons: prompt.icons, controls: prompt.controls }];
  }

  // --- Building ---------------------------------------------------------------------------------

  private el<T extends UIComponentType>(world: World, type: new () => T, name: string, parent: GameObject, init: Partial<T> = {}): T {
    const node = world._createNode(name, parent.entity);
    return node.addBehavior(type as never, init as never) as T;
  }

  private build(world: World): Built {
    let underCanvas = false;
    for (let n: GameObject | null = this.node; n; n = n.parent) if (n.getComponent(UICanvas)) underCanvas = true;
    // A full-size box that centres the panel: in the canvas above, else in a screen canvas of its own.
    const root = underCanvas ? world._createNode("ControlMapper", this.node.entity) : this.el(world, UICanvas, "ControlMapper", this.node, { sortOrder: 100 }).node;
    const host = this.el(world, UIPanel, "Screen", root, { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" }).node;
    const panel = this.el(world, UIPanel, "Panel", host, { flexDirection: "column", padding: 24, gap: 10, borderRadius: 12 });
    const title = this.el(world, UIText, "Title", panel.node, { fontWeight: "bold" });
    const header = this.el(world, UIPanel, "Header", panel.node, { gap: 8, alignItems: "center" });
    const headerAction = this.el(world, UIText, "Action", header.node, { width: "34%" });
    const headerKeyboard = this.el(world, UIText, "Keyboard", header.node, { flexGrow: 1, width: 0 as UILength });
    const headerGamepad = this.el(world, UIText, "Gamepad", header.node, { flexGrow: 1, width: 0 as UILength });
    const list = this.el(world, UIPanel, "Rows", panel.node, { flexDirection: "column", gap: 6 });
    const status = this.el(world, UIText, "Status", panel.node, {});
    const footer = this.el(world, UIPanel, "Buttons", panel.node, { gap: 8, justifyContent: "flex-end" });
    const reset = this.el(world, UIButton, "Reset", footer.node, { borderWidth: 2 });
    const resetText = this.el(world, UIText, "Label", reset.node, {});
    const save = this.el(world, UIButton, "Save", footer.node, { borderWidth: 2 });
    const saveText = this.el(world, UIText, "Label", save.node, {});
    return { root, panel, title, headerAction, headerKeyboard, headerGamepad, list, status, reset, resetText, save, saveText, signature: "", rows: [] };
  }

  private buildCell(world: World, row: GameObject, device: UIControlMapperDevice): CellState {
    const button = this.el(world, UIButton, device === "keyboard" ? "Keyboard" : "Gamepad", row, { flexGrow: 1, width: 0 as UILength, height: (this.glyphSize + 14) as UILength, padding: 6, gap: 8, justifyContent: "flex-start", borderWidth: 2 });
    const images: UIImage[] = [];
    for (let i = 0; i < IMAGES_PER_CELL; i++) images.push(this.el(world, UIImage, `Glyph${i}`, button.node, { display: "none" }));
    const text = this.el(world, UIText, "Label", button.node, { wordBreak: "keep-all" });
    return { device, label: "", icons: [], part: null, context: null, controls: [], conflict: false, button, text, images };
  }

  /** Work out the rows from the player's bindings; rebuild the row elements when their shape changed. */
  private syncRows(world: World, built: Built, input: PlayerInput | null): void {
    type Want = { action: string; part: string | null; label: string; keyboard: Entry | null; gamepad: Entry | null; kbContext: string | null; gpContext: string | null };
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
          want.push({ action, part, label: part ? `${name} ${this.text.parts[part] ?? part}` : name, keyboard: k, gamepad: g, kbContext: kp?.context ?? null, gpContext: gp?.context ?? null });
        }
      }
    }
    const signature = `${this.keyboard}|${this.gamepad}|${want.map((w) => `${w.action}/${w.part}`).join(",")}`;
    if (signature !== built.signature) {
      built.signature = signature;
      for (const r of built.rows) if (r.name.node.parent?.isValid) world._destroyNode(r.name.node.parent.entity);
      built.rows = want.map((w, i) => {
        const row = this.el(world, UIPanel, `Row${i}`, built.list.node, { gap: 8, alignItems: "center" });
        const name = this.el(world, UIText, "Name", row.node, { width: "34%" });
        return { action: w.action, part: w.part, label: w.label, name, keyboard: this.keyboard ? this.buildCell(world, row.node, "keyboard") : null, gamepad: this.gamepad ? this.buildCell(world, row.node, "gamepad") : null };
      });
      this.clampSelection(built);
    }
    // Contents.
    const uses = new Map<string, number>();
    want.forEach((w, i) => {
      const r = built.rows[i];
      r.label = w.label;
      for (const [cell, entry, context] of [
        [r.keyboard, w.keyboard, w.kbContext],
        [r.gamepad, w.gamepad, w.gpContext],
      ] as const) {
        if (!cell) continue;
        cell.label = entry?.label ?? this.text.none;
        cell.icons = entry?.icons ?? [];
        cell.part = entry?.part ?? null;
        cell.context = entry ? context : null;
        cell.controls = entry?.controls ?? [];
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

  // --- Input ------------------------------------------------------------------------------------

  /** Columns of a row: its cells, or Reset and Save on the button row. */
  private columns(built: Built, row: number): (CellState | "reset" | "save")[] {
    if (row >= built.rows.length) return ["reset", "save"];
    const r = built.rows[row];
    return [r.keyboard, r.gamepad].filter((c): c is CellState => c !== null);
  }

  private clampSelection(built: Built): void {
    this.selection.row = Math.max(0, Math.min(this.selection.row, built.rows.length));
    this.selection.column = Math.max(0, Math.min(this.selection.column, this.columns(built, this.selection.row).length - 1));
  }

  private handleInput(built: Built, input: PlayerInput): void {
    // The pointer: hovering selects, clicking activates.
    for (let row = 0; row <= built.rows.length; row++) {
      this.columns(built, row).forEach((c, column) => {
        const button = c === "reset" ? built.reset : c === "save" ? built.save : c.button;
        if (button.hovered) this.selection = { row, column };
        if (button.clicked) {
          this.selection = { row, column };
          this.activate(built, input);
        }
      });
    }
    if (this.waiting) return;
    // Keys and the d-pad of the player's devices.
    for (const e of DeviceEvents.read()) {
      if (Math.abs(e.value) < 0.5 || e.device.getData(InputDevice)?.player !== input.index) continue;
      const dir = NAV_DIRS[e.control];
      if (dir) this.move(built, dir);
      else if (CONFIRM.has(e.control)) {
        this.activate(built, input);
        if (this.waiting) return;
      }
    }
  }

  private move(built: Built, dir: "up" | "down" | "left" | "right"): void {
    const s = this.selection;
    if (dir === "up" || dir === "down") {
      s.row = Math.max(0, Math.min(built.rows.length, s.row + (dir === "up" ? -1 : 1)));
    } else s.column += dir === "left" ? -1 : 1;
    this.clampSelection(built);
  }

  private activate(built: Built, input: PlayerInput): void {
    const { row, column } = this.selection;
    const c = this.columns(built, row)[column];
    if (!c) return;
    if (c === "reset") {
      input.resetBindings();
      this.lastConflicts = [];
      this.setStatus(this.text.resetDone);
      return;
    }
    if (c === "save") {
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
    if (!c.part) return;
    const action = built.rows[row].action;
    try {
      input.rebind(action, { device: c.device, part: c.part, context: c.context ?? undefined, cancel: "<Keyboard>/escape", timeout: this.timeout > 0 ? this.timeout : undefined }).catch(() => {});
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), true);
      return;
    }
    this.waiting = { action, device: c.device, rowIndex: row, column };
    this.setStatus(fill(c.device === "keyboard" ? this.text.waitingKey : this.text.waitingButton, { cancel: "Esc" }));
  }

  // --- Drawing ----------------------------------------------------------------------------------

  private paint(built: Built): void {
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
    built.rows.forEach((r, rowIndex) => {
      text(r.name, r.label);
      [r.keyboard, r.gamepad]
        .filter((c): c is CellState => c !== null)
        .forEach((cell, column) => {
          const waiting = this.waiting?.rowIndex === rowIndex && this.waiting.column === column;
          const selected = this.selection.row === rowIndex && this.selection.column === column;
          this.styleButton(cell.button, selected, waiting);
          const label = waiting ? (cell.device === "keyboard" ? this.text.pressKey : this.text.pressButton) : cell.label;
          text(cell.text, label, waiting ? this.textColor : cell.conflict ? this.warningColor : cell.part ? this.textColor : this.mutedColor);
          cell.button.interactable = cell.part !== null;
          const glyphs = waiting ? [] : cell.icons.map((k) => InputGlyphs.get(k)).filter((g) => g !== null);
          cell.images.forEach((img, i) => {
            const g = glyphs[i];
            img.display = g ? "flex" : "none";
            if (!g) return;
            if (img.image !== g.asset) img.image = g.asset;
            img.height = this.glyphSize;
            img.width = Math.round((this.glyphSize * g.width) / g.height);
          });
        });
    });
    const footerRow = built.rows.length;
    this.styleButton(built.reset, this.selection.row === footerRow && this.selection.column === 0, false);
    this.styleButton(built.save, this.selection.row === footerRow && this.selection.column === 1, false);
    text(built.resetText, this.text.reset);
    text(built.saveText, this.text.save);
  }

  private styleButton(b: UIButton, selected: boolean, waiting: boolean): void {
    b.backgroundColor = waiting ? this.accentColor : this.cellColor;
    b.hoverColor = waiting ? this.accentColor : this.hoverColor;
    b.pressedColor = this.pressedColor;
    b.borderColor = selected || waiting ? this.accentColor : this.cellColor;
  }
}

function cellView(c: CellState): UIControlMapperCell {
  return { device: c.device, label: c.label, icons: [...c.icons], part: c.part, conflict: c.conflict, button: c.button };
}

function mappersOf(world: World): UIControlMapper[] {
  return [...live].filter((m) => m.node.isValid && m._world === world);
}

// After the UI documents' events (so clicks are read the frame scripts see them) and before behaviors' update.
defineBuiltinSystem({ name: "engine.UIControlMapper", phase: "update", after: ["engine.UIDocumentEvents", "engine.InputFrame"], before: ["engine.UpdateScripts"], run: (w) => mappersOf(w).forEach((m) => m._frame(w)) });
