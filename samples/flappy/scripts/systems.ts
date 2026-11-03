import { GameObject, Transform, defineSystem, type DataView } from "myco";
import { Despawn, GameState, Scroller } from "./data";

type ScrollerView = DataView<typeof Scroller.schema>;
type DespawnView = DataView<typeof Despawn.schema>;

/** Scrolls ground, background and pipes; stops when the game state says so. */
defineSystem({
  name: "game.Scroll",
  phase: "update",
  query: [Transform, Scroller],
  run(rows, ctx) {
    const state = ctx.single<{ scrolling: number }>(GameState);
    if (state && !state.scrolling) return;
    for (const row of rows) {
      const s = row.scroller as ScrollerView;
      const p = row.transform.position;
      p.x -= s.speed * ctx.dt;
      if (s.wrapWidth > 0 && p.x <= -s.wrapWidth) p.x += 2 * s.wrapWidth;
    }
  },
});

/** Removes pipes once they have left the screen. */
defineSystem({
  name: "game.Despawn",
  phase: "lateUpdate",
  query: [Transform, Despawn],
  run(rows) {
    for (const row of rows) {
      if (row.transform.worldPosition.x < (row.despawn as DespawnView).minX) GameObject.destroy(row.node);
    }
  },
});
