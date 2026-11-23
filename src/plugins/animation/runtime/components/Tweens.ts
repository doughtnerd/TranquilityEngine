/**
 * The tween data component (ADR 0372): on the entity of every node a tween is animating, holding handles into the core's
 * tween table (ADR 0370). `tween()` adds it; `animation.Apply` removes it when the entity's last tween ends (T22t).
 * Systems can query it to find what is being tweened (`query: [Tweens]`).
 */
import { defineComponent, i32 } from "../../../../engine/core/data";

/**
 * `count`: tweens running on the entity (group members included); `head`: the core handle (index and generation) of its
 * newest tween, or of the group program a newest member runs in.
 */
export const Tweens = defineComponent("animation.Tweens", { count: i32, head: i32 });
