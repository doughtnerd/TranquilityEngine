import { GameBehavior, Input, Mathf, Physics2D, RigidBody2D, Tilemap, Time, Vector2, behavior, field, GameObject } from "myco";

/**
 * The player: runs with A/D or the arrow keys and jumps with Space, W or Up when standing on
 * something. Coins, spikes and the flag are tiles; the player reads their tile data (ADR 0103).
 */
@behavior("game.Player")
export class Player extends GameBehavior {
  @field(GameObject) level: GameObject | null = null;
  @field(Number) runSpeed = 7;
  @field(Number) jumpSpeed = 14;
  @field(Number) acceleration = 60;

  coins = 0;
  won = false;
  /** Read the keyboard; off, `move` and `jumpQueued` are set by other code (tests, touch controls). */
  useKeyboard = true;
  /** -1, 0 or 1: the direction to run in. */
  move = 0;
  /** Jump at the next fixed step, if standing on something. */
  jumpQueued = false;

  private rb!: RigidBody2D;
  private map: Tilemap | null = null;
  private spawn = new Vector2(0, 0);

  awake(): void {
    this.rb = this.node.getBehavior(RigidBody2D)!;
    this.map = this.level?.getBehavior(Tilemap) ?? null;
    const p = this.transform.position;
    this.spawn.set(p.x, p.y);
  }

  update(): void {
    if (!this.useKeyboard) return;
    let move = 0;
    if (Input.getKey("arrowleft") || Input.getKey("a")) move -= 1;
    if (Input.getKey("arrowright") || Input.getKey("d")) move += 1;
    this.move = move;
    if (Input.getKeyDown("space") || Input.getKeyDown("w") || Input.getKeyDown("arrowup")) this.jumpQueued = true;
  }

  fixedUpdate(): void {
    const v = this.rb.velocity;
    const target = this.move * this.runSpeed;
    const step = this.acceleration * Time.fixedDeltaTime;
    v.x = Mathf.clamp(target, v.x - step, v.x + step);
    if (this.jumpQueued) {
      if (this.grounded) v.y = this.jumpSpeed;
      this.jumpQueued = false;
    }
    this.touchTiles();
    if (this.transform.position.y < -10) this.respawn();
  }

  /** Something solid just under the feet (tiles, crates and one-way planks alike). */
  get grounded(): boolean {
    if (this.rb.velocity.y > 0.1) return false;
    const p = this.transform.position;
    for (const dx of [-0.3, 0, 0.3]) {
      const hit = Physics2D.raycast({ x: p.x + dx, y: p.y - 0.4 }, { x: 0, y: -1 }, 0.15, ["World"]);
      if (hit) return true;
    }
    return false;
  }

  /** Coins are picked up, spikes send the player back to the start, the flag wins. */
  private touchTiles(): void {
    const map = this.map;
    if (!map) return;
    const p = this.transform.position;
    const cell = map.worldToCell(p);
    const layer = map.layerIndex("Ground");
    const data = map.getTileData<{ coin?: boolean; hazard?: boolean; goal?: boolean }>(cell.x, cell.y, layer);
    if (!data) return;
    if (data.coin) {
      map.clearTile(cell.x, cell.y, layer);
      this.coins++;
    } else if (data.hazard) {
      this.respawn();
    } else if (data.goal && !this.won) {
      this.won = true;
      console.log(`[platformer] You reached the flag with ${this.coins} coins!`);
    }
  }

  respawn(): void {
    this.transform.position = [this.spawn.x, this.spawn.y, 0];
    this.rb.velocity = { x: 0, y: 0 };
  }
}
