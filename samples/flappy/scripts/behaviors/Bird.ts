import { GameBehavior, GameObject, Input, Mathf, RigidBody2D, Time, behavior, field, type Collider2D, type Collision2D } from "myco";
import { BirdEvents } from "../data";

export function flapPressed(): boolean {
  return Input.getKeyDown("space") || Input.getKeyDown("arrowup") || Input.getKeyDown("w") || Input.getMouseButtonDown(0);
}

/** The player. Hovers until the game starts, then flaps against gravity until it hits something. */
@behavior("game.Bird")
export class Bird extends GameBehavior {
  @field(Number) flapVelocity = 10.5;
  @field(Number) maxFallSpeed = 16;
  @field(Number) hoverAmplitude = 0.3;
  /** Child node holding the sprite; tilted with velocity so the physics body never rotates. */
  @field(GameObject) visual: GameObject | null = null;

  flying = false;
  alive = true;
  private rb!: RigidBody2D;
  private baseY = 0;

  awake(): void {
    this.rb = this.node.getBehavior(RigidBody2D)!;
    this.rb.useGravity = false;
    this.baseY = this.transform.position.y;
  }

  /** Called by the GameManager on the first press. */
  startFlying(): void {
    this.flying = true;
    this.rb.useGravity = true;
    this.flap();
  }

  update(): void {
    if (!this.flying) {
      this.transform.position.y = this.baseY + Math.sin(Time.time * 5) * this.hoverAmplitude;
      return;
    }
    if (this.alive && flapPressed()) this.flap();

    const velocity = this.rb.velocity;
    if (velocity.y < -this.maxFallSpeed) velocity.y = -this.maxFallSpeed;

    const t = this.visual?.transform;
    if (t) {
      const target = this.alive ? Mathf.clamp(velocity.y * 3, -80, 25) : -80;
      t.rotation2D = Mathf.lerp(t.rotation2D, target, Math.min(1, Time.deltaTime * 10));
    }
  }

  private flap(): void {
    this.rb.velocity = { x: 0, y: this.flapVelocity };
  }

  onTriggerEnter(other: Collider2D): void {
    if (!this.alive) return;
    if (other.layer === "Obstacle") this.die();
    else if (other.layer === "Score") BirdEvents.push({ kind: "scored" });
  }

  onCollisionEnter(collision: Collision2D): void {
    if (collision.collider.layer === "Ground" && this.alive) this.die();
  }

  private die(): void {
    this.alive = false;
    const v = this.rb.velocity;
    if (v.y > 0) v.y = 0;
    BirdEvents.push({ kind: "died" });
  }
}
