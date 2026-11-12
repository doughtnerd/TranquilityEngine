import { Audio, GameBehavior, GameObject, Input, SceneManager, Storage, Text, behavior, field } from "myco";
import { BirdEvents, GameState } from "../data";
import { MusicReadout, touchToggle } from "../musicReadout";
import { Bird, flapPressed } from "./Bird";
import { PipeSpawner } from "./PipeSpawner";

type State = "ready" | "playing" | "dead";

/** On game over the town music dips to this share of the Music bus's volume, and comes back when the next run starts. */
const DUCK = 0.35;
/** The Music bus's volume before the dip (null: not dipped). Module state outlives the scene reload that restarts the run. */
let duckedFrom: number | null = null;

function duckMusic(): void {
  const bus = Audio.bus("Music");
  if (duckedFrom === null) duckedFrom = bus.volume;
  bus.fadeTo(duckedFrom * DUCK, 0.4);
}

function restoreMusic(seconds: number): void {
  if (duckedFrom === null) return;
  Audio.bus("Music").fadeTo(duckedFrom, seconds);
  duckedFrom = null;
}

/** Runs the ready → playing → game over loop, keeps score and the best score. */
@behavior("game.GameManager")
export class GameManager extends GameBehavior {
  @field(GameObject) bird: GameObject | null = null;
  @field(GameObject) spawner: GameObject | null = null;
  @field(GameObject) scoreLabel: GameObject | null = null;
  @field(GameObject) messageLabel: GameObject | null = null;
  /** A text label that shows the music readout (key M, or the music button on a touch screen). */
  @field(GameObject) musicLabel: GameObject | null = null;
  @field(String) musicKey = "m";
  @field(Number) restartDelay = 0.6;

  state: State = "ready";
  score = 0;
  best = 0;
  private canRestart = false;
  private readonly readout = new MusicReadout();
  private touchPressed = false;
  private removeTouchToggle: (() => void) | null = null;

  async start(): Promise<void> {
    restoreMusic(0.2);
    this.removeTouchToggle = touchToggle(() => (this.touchPressed = true));
    this.setMessage("Press Space or click to flap");
    this.setScore();
    this.best = (await Storage.load<number>("best")) ?? 0;
  }

  onDestroy(): void {
    this.removeTouchToggle?.();
    this.removeTouchToggle = null;
  }

  update(): void {
    this.showMusic();
    if (this.state === "ready" && flapPressed()) {
      this.state = "playing";
      this.bird?.getBehavior(Bird)?.startFlying();
      const spawner = this.spawner?.getBehavior(PipeSpawner);
      if (spawner) spawner.enabled = true;
      this.setMessage("");
    } else if (this.state === "dead" && this.canRestart && flapPressed()) {
      restoreMusic(0.4);
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
    duckMusic();
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

  /** The music readout: M (or the touch button) toggles it; it shows `Audio.debug().music` four times a second. */
  private showMusic(): void {
    if (Input.getKeyDown(this.musicKey) || this.touchPressed) this.readout.toggle();
    this.touchPressed = false;
    const label = this.musicLabel?.getBehavior(Text);
    const text = this.readout.lines();
    if (label && label.text !== text) label.text = text;
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
