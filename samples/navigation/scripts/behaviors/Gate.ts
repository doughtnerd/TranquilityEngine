import { GameBehavior, NavGate, behavior } from "myco";
import { GateTimer } from "./GateTimer";

/**
 * Sits beside a NavGate and takes the GateTimer's current state the moment the gate is enabled: when its chunk
 * scene streams in, the scene's saved `open` would otherwise stand until the timer's next fixed step.
 */
@behavior("navdemo.Gate")
export class Gate extends GameBehavior {
  onEnable(): void {
    const gate = this.node.getBehavior(NavGate);
    if (gate) GateTimer.find()?.applyTo(gate);
  }
}
