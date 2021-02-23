import GameBehavior from "../../engine/GameBehavior";
import { Vector3 } from "../../engine/Vector3";

export class PipeSpawner extends GameBehavior {
  positions = {
    0: {
      up: new Vector3(0, -3, 0),
      down: new Vector3(0, 12, 0),
    },
    1: {
      up: new Vector3(0, -5, 0),
      down: new Vector3(0, 10, 0),
    },
    2: {
      up: new Vector3(0, -7, 0),
      down: new Vector3(0, 8, 0),
    },
    3: {
      up: new Vector3(0, -9, 0),
      down: new Vector3(0, 6, 0),
    },
    4: {
      up: new Vector3(0, -10, 0),
      down: new Vector3(0, 5, 0),
    },
  };
}
