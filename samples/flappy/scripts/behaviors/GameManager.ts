import { GameBehavior, GameObject, SceneManager, Storage, Text, behavior, field } from "tranquility";
import { BirdEvents, GameState } from "../data";
import { Bird, flapPressed } from "./Bird";
import { PipeSpawner } from "./PipeSpawner";

type State = "ready" | "playing" | "dead";

/** Runs the ready → playing → game over loop, keeps score and the best score. */
@behavior("game.GameManager")
export class GameManager extends GameBehavior {
  @field(GameObject) bird: GameObject | null = null;
  @field(GameObject) spawner: GameObject | null = null;
  @field(GameObject) scoreLabel: GameObject | null = null;
  @field(GameObject) messageLabel: GameObject | null = null;
  @field(Number) restartDelay = 0.6;

  state: State = "ready";
  score = 0;
  best = 0;
  private canRestart = false;

  async start(): Promise<void> {
    this.setMessage("Press Space or click to flap");
    this.setScore();
    this.best = (await Storage.load<number>("best")) ?? 0;
  }

  update(): void {
    if (this.state === "ready" && flapPressed()) {
      this.state = "playing";
      this.bird?.getBehavior(Bird)?.startFlying();
      const spawner = this.spawner?.getBehavior(PipeSpawner);
      if (spawner) spawner.enabled = true;
      this.setMessage("");
    } else if (this.state === "dead" && this.canRestart && flapPressed()) {
      void SceneManager.load("scenes/main.scene.json");
    }

    for (const event of BirdEvents.read()) {
      if (event.kind === "scored" && this.state === "playing") {
        this.score++;
        this.setScore();
      } else if (event.kind === "died" && this.state === "playing") {
        void this.gameOver();
      }
    }
  }

  private async gameOver(): Promise<void> {
    this.state = "dead";
    const gameState = this.node.getData(GameState);
    if (gameState) gameState.scrolling = 0;
    const spawner = this.spawner?.getBehavior(PipeSpawner);
    if (spawner) spawner.enabled = false;

    const newBest = this.score > this.best;
    if (newBest) {
      this.best = this.score;
      void Storage.save("best", this.best);
    }
    this.setMessage(`Game over\nScore ${this.score}  ·  Best ${this.best}${newBest && this.score > 0 ? "  (new!)" : ""}`);
    await this.wait.seconds(this.restartDelay);
    this.canRestart = true;
    this.setMessage(`Game over\nScore ${this.score}  ·  Best ${this.best}\n\nPress Space to play again`);
  }

  private setScore(): void {
    const label = this.scoreLabel?.getBehavior(Text);
    if (label) label.text = String(this.score);
  }

  private setMessage(text: string): void {
    const label = this.messageLabel?.getBehavior(Text);
    if (label) label.text = text;
  }
}
