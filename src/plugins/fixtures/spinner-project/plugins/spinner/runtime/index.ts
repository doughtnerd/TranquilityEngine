// The Spinner plugin's runtime half (ADR 0139): one Component, claimed in `activate` so turning the
// plugin off unregisters it (scenes keep its data and show it as missing).
import { Component, Mathf, Time, component, field, type RuntimePluginContext } from "myco";

/** Turns its node around z at `speed` degrees a second (rotate2D takes radians). */
@component("acme.Spinner")
export class Spinner extends Component {
  @field(Number) speed = 90;

  update(): void {
    this.transform.rotate2D(this.speed * Mathf.Deg2Rad * Time.deltaTime);
  }
}

/** How many times this half was activated (tests read it to see a reload re-activate it). */
export let activations = 0;

export function activate(context: RuntimePluginContext): void {
  activations++;
  context.registerComponents([Spinner]);
}
