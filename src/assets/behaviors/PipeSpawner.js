import GameBehavior from "../../engine/GameBehavior";
import GameObject from "../../engine/GameObject";
import SceneManager from "../../engine/SceneManager";
import Time from "../../engine/Time";
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

  pipeParent = null;

  awake() {
    this.spawn();
  }

  update() {
    if(this.pipeParent) {
      const scaledVelocity = Vector3.scale(new Vector3(-5, 0, 0), Time.deltaTime);
      this.pipeParent.transform.position = Vector3.add(this.pipeParent.transform.position, scaledVelocity);
  
      if(this.pipeParent.transform.position.x < -15) {
        SceneManager.activeScene.destroy(this.pipeParent);
        this.pipeParent = null;
      }
    } else {
      this.spawn();
    }
  }

  spawn() {
    const min = Math.ceil(0);
    const max = Math.floor(4);
    const index = Math.floor(Math.random() * (max - min + 1)) + min;
    this.pipeParent = SceneManager.activeScene.instantiate(GameObject)
    const up = SceneManager.activeScene.instantiate(PipeUp, this.pipeParent.transform);
    const down = SceneManager.activeScene.instantiate(PipeDown, this.pipeParent.transform);

    this.pipeParent.transform.position = new Vector3(18, 0, 0);

    up.transform.localPosition = this.positions[index].up;
    down.transform.localPosition = this.positions[index].down;
  }
}
