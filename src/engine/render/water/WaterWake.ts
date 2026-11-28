/**
 * Wakes on water (ADR 0451): a `WaterWake` on a moving node (a boat) makes the World's water surfaces
 * draw its wake in their own shader, as strong as the node is fast. The surface's `wakeMode` picks how:
 * a foam trail with Kelvin ripples along the path the stern took ("trail"), or a simulated wave height
 * field the hull presses into ("field"). Engine-native and renderer-neutral: the state is `wakes.ts`'s.
 */
import { Component } from "../../core/Component";
import { component, field } from "../../core/registry";

/**
 * Makes water surfaces draw a wake behind this node while it moves. Its speed is measured from how
 * the node moves (no script needs to feed it); `strength` scales the wake (0 hides it at once, as
 * disabling the component does). The node's +Z is its bow.
 */
@component("engine.WaterWake")
export class WaterWake extends Component {
  /** 0–1: scales the whole wake. Set 0 (or disable the component) to hide it at once. */
  @field(Number) strength = 1;
  /** The speed (m/s) at which the wake is at full size; slower, it is smaller, and none at rest. */
  @field(Number) fullSpeed = 6;
  /** The foam trail's width at the stern (m); it widens behind. The hull's beam in "field" mode is a little over half of it. */
  @field(Number) width = 3;
  /** Seconds churned water lasts behind the boat. */
  @field(Number) life = 2.6;
  /** Where the stem meets the water, ahead of the node along its +Z (m). */
  @field(Number) bow = 2;
  /** Where the stern is, along its +Z (m; behind the node is negative). */
  @field(Number) stern = -2;
  /** 0–1: how white the wake is. */
  @field(Number) foam = 0.6;
  /** 0–1: how strongly the wake's waves bend the surface. */
  @field(Number) ripples = 0.6;
}
