import { Animator, GameBehavior, GameObject, Input, SceneManager, UIView, behavior, field } from "myco";
import { GemPulse } from "./GemPulse";
import { SproutController } from "./SproutController";

/**
 * The main scene's HUD (ui/Hud.svelte): what the Sprout's graph is doing (its state, the transition under way, the
 * speed parameter) and the notifies heard, read every frame from the public Animator API. Key 2 opens the sprites page.
 */
@behavior("demo.LabHud")
export class LabHud extends GameBehavior {
  @field(GameObject) sprout: GameObject | null = null;
  @field(GameObject) lantern: GameObject | null = null;

  update(): void {
    if (Input.getKeyDown("2")) {
      void SceneManager.load("scenes/sprites.scene.json");
      return;
    }
    const ui = this.node.getBehavior(UIView);
    const anim = this.sprout?.getBehavior(Animator);
    const control = this.sprout?.getBehavior(SproutController);
    if (!ui || !anim || !control) return;
    const s = anim.state();
    const state = s.name ? `${s.name}${s.transitioningTo ? ` → ${s.transitioningTo}` : ""}` : "loading…";
    ui.props.sprout = `State  ${state}\nSpeed  ${control.speed.toFixed(2)}${control.autopilot ? "  (autopilot)" : ""}\nLandings  ${control.landings}`;
    ui.props.lantern = `Chimes  ${this.lantern?.getBehavior(GemPulse)?.chimes ?? 0}`;
  }
}
