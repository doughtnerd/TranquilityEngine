/**
 * The UI interaction log (ADR 0309): what the player did to one World's UI, recorded by the UI core
 * and read by the components' getters and UI documents. Nothing here is public API.
 *
 * One timing rule: events recorded since the last routing (the hidden input's typing and Enter between
 * frames, and the routing's own hovers and clicks) are published by the next routing, stamped with the
 * frame the World steps next. Every script phase of that frame sees them; the frame after, none.
 */
import type { World } from "../core/World";
import type { UIButton, UIInputField } from "./components";

export type UIInteractionType = "click" | "change" | "submit" | "hover";

type Target = UIButton | UIInputField;

/** What the routing found this frame (ADR 0069): the button under the pointer, the one a press began on, a finished click. */
export interface UIPointerState {
  readonly hovered: UIButton | null;
  readonly pressed: UIButton | null;
  readonly clicked: UIButton | null;
}

export class UIInteractions {
  private hoveredButton: UIButton | null = null;
  private pressedButton: UIButton | null = null;
  private focusedField: UIInputField | null = null;
  private pending: { type: UIInteractionType; target: Target }[] = [];
  /** The frame `published` is for. */
  private frame = -1;
  private published = new Map<Target, Set<UIInteractionType>>();

  constructor(private readonly world: World) {}

  // --- Recording: the UI core -------------------------------------------------------------------

  /** The player changed a field's value or pressed Enter in it, between frames. */
  record(type: "change" | "submit", field: UIInputField): void {
    this.pending.push({ type, target: field });
  }

  /**
   * The routing (run before the World steps): take what the pointer did, then publish everything
   * recorded since the last routing for the World's next frame. A submit whose field lost focus is dropped.
   */
  route(pointer: UIPointerState): void {
    if (pointer.hovered && pointer.hovered !== this.hoveredButton) this.pending.push({ type: "hover", target: pointer.hovered });
    if (pointer.clicked) this.pending.push({ type: "click", target: pointer.clicked });
    this.hoveredButton = pointer.hovered;
    this.pressedButton = pointer.pressed;
    const frame = this.world.time.frameCount + 1;
    if (frame !== this.frame) {
      this.published = new Map();
      this.frame = frame;
    }
    for (const { type, target } of this.pending) {
      if (type === "submit" && target !== this.focusedField) continue;
      const types = this.published.get(target);
      if (types) types.add(type);
      else this.published.set(target, new Set([type]));
    }
    this.pending = [];
  }

  /** The World doesn't take the pointer now (not interactive, or no local input): nothing hovered or pressed, nothing recorded. */
  idle(): void {
    this.hoveredButton = null;
    this.pressedButton = null;
    this.pending = [];
  }

  // --- Focus: the routing, the hidden input and scripts -----------------------------------------

  /** Focus `field` (null: none). One field per World has focus. */
  focus(field: UIInputField | null): void {
    this.focusedField = field;
  }

  /** Take focus from `field` if it has it. */
  blur(field: UIInputField): void {
    if (this.focusedField === field) this.focusedField = null;
  }

  // --- Reading: component getters and UI documents ----------------------------------------------

  /** True in the frame the event is for (the World's current frame). */
  happened(target: Target, type: UIInteractionType): boolean {
    return this.frame === this.world.time.frameCount && (this.published.get(target)?.has(type) ?? false);
  }

  isHovered(button: UIButton): boolean {
    return this.hoveredButton === button;
  }

  isPressed(button: UIButton): boolean {
    return this.pressedButton === button;
  }

  isFocused(field: UIInputField): boolean {
    return this.focusedField === field;
  }
}

const logs = new WeakMap<World, UIInteractions>();

/** The World's interaction log, made the first time it's asked for. */
export function uiInteractions(world: World): UIInteractions {
  let log = logs.get(world);
  if (!log) logs.set(world, (log = new UIInteractions(world)));
  return log;
}
