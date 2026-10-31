import { defineBuffer, defineComponent, f32, u8 } from "../../engine";

/** Moves a node left at `speed`; with `wrapWidth > 0` it leapfrogs to stay on screen (two tiles). */
export const Scroller = defineComponent("game.Scroller", { speed: f32, wrapWidth: f32 });

/** Destroys a node once its world x drops below `minX`. */
export const Despawn = defineComponent("game.Despawn", { minX: f32 });

/** Singleton game state shared with systems. */
export const GameState = defineComponent("game.GameState", { scrolling: u8 });

/** What happened to the bird this frame (ADR 0017: buffers instead of events). */
export const BirdEvents = defineBuffer<{ kind: "scored" | "died" }>("game.BirdEvents");
