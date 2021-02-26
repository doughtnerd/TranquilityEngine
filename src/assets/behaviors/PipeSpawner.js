import GameBehavior from "../../engine/GameBehavior";
import SceneManager from "../../engine/SceneManager";
import { Vector3 } from "../../engine/Vector3";
import PipeDown from "../gameObjects/PipeDown";
import PipeUp from "../gameObjects/PipeUp";

export default class PipeSpawner extends GameBehavior {
  positions = [
    {
      up: new Vector3(0, -3, 0),
      down: new Vector3(0, 12, 0),
    },
    {
      up: new Vector3(0, -5, 0),
      down: new Vector3(0, 10, 0),
    },
    {
      up: new Vector3(0, -7, 0),
      down: new Vector3(0, 8, 0),
    },
    {
      up: new Vector3(0, -9, 0),
      down: new Vector3(0, 6, 0),
    },
    {
      up: new Vector3(0, -10, 0),
      down: new Vector3(0, 5, 0),
    },
  ];

  awake() {
    const up = SceneManager.activeScene.instantiate(PipeUp);
    const down = SceneManager.activeScene.instantiate(PipeDown);

    up.transform.position = this.positions[0].up;
    down.transform.position = this.positions[0].down;
  }
}
