import { AudioOccluder, GameBehavior, Input, Time, behavior, field } from "myco";

/**
 * A door for sound (ADR 0162, the door recipe in docs/guide/spatial-audio.md). Put it on the node that carries the door's
 * collider and its `AudioOccluder`. The collider stays where it is: what the audio system hears is the occluder's
 * `openness` (0 closed, 1 open), which blends the wall's muffling away. This script moves `openness` toward the target a
 * little each frame, so the door fades open and shut instead of clicking, and slides a child node (the panel) up out of
 * the doorway so the picture agrees with the sound. The key toggles it; `autoCycle` toggles it on a timer.
 */
@behavior("lab.Door")
export class Door extends GameBehavior {
  /** The key that opens and closes the door. */
  @field(String) key = "f";
  /** Seconds the door takes to go from closed to open (or back). */
  @field(Number) seconds = 0.8;
  /** Toggles the door by itself every this many seconds. 0 leaves it to the key. */
  @field(Number) autoCycle = 0;
  /** Name of the child node to slide up as the door opens. Empty slides nothing. */
  @field(String) panel = "Panel";
  /** How far the panel slides at fully open, in metres. */
  @field(Number) lift = 3;
  private target = 0;
  private nextToggle = 0;
  private panelY: number | null = null;

  /** True once the door is opening or open. */
  get isOpen(): boolean {
    return this.target === 1;
  }

  /** Opens (true) or closes (false) the door. */
  setOpen(open: boolean): void {
    this.target = open ? 1 : 0;
  }

  update(): void {
    const occluder = this.node.getComponent(AudioOccluder);
    if (!occluder) return;
    if (Input.getKeyDown(this.key)) this.setOpen(!this.isOpen);
    if (this.autoCycle > 0 && Time.time >= this.nextToggle) {
      if (this.nextToggle > 0) this.setOpen(!this.isOpen);
      this.nextToggle = Time.time + this.autoCycle;
    }
    const step = Time.deltaTime / Math.max(this.seconds, 0.01);
    const o = occluder.openness;
    occluder.openness = this.target > o ? Math.min(this.target, o + step) : Math.max(this.target, o - step);

    const panel = this.panel ? this.node.find(this.panel) : null;
    const t = panel?.transform;
    if (t) {
      this.panelY ??= t.position.y;
      t.position.y = this.panelY + this.lift * occluder.openness;
    }
  }
}
