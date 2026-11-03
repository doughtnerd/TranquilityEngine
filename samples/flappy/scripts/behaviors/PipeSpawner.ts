import { AssetRef, GameBehavior, GameObject, Mathf, behavior, field } from "myco";

/** Spawns pipe pairs at random heights while enabled (ADR 0018 waits drive the loop). */
@behavior("game.PipeSpawner")
export class PipeSpawner extends GameBehavior {
  @field(AssetRef) prefab = "prefabs/pipe-pair.prefab.json";
  @field(Number) interval = 1.7;
  @field(Number) spawnX = 13;
  @field(Number) minGapY = -3;
  @field(Number) maxGapY = 5;

  onEnable(): void {
    void this.spawnLoop();
  }

  /** Runs until the behavior is disabled or destroyed; the pending wait is then dropped. */
  private async spawnLoop(): Promise<void> {
    while (true) {
      this.spawn();
      await this.wait.seconds(this.interval);
    }
  }

  spawn(): GameObject {
    return GameObject.instantiate(this.prefab, {
      parent: this.node.scene,
      position: [this.spawnX, Mathf.randomRange(this.minGapY, this.maxGapY), 0],
    });
  }
}
