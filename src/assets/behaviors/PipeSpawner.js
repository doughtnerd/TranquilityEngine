import GameBehavior from "../../engine/GameBehavior";
import GameObject from "../../engine/GameObject";
import RigidBody from "../../engine/physics/RigidBody";
import SceneManager from "../../engine/SceneManager";
import Time from "../../engine/Time";
import { Vector3 } from "../../engine/Vector3";
import PipeDown from "../gameObjects/PipeDown";
import PipeUp from "../gameObjects/PipeUp";
import {Vec3} from 'cannon';
import BoxCollider from "../../engine/physics/BoxCollider";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import spritey from '../images/moderncraft.png';
export default class PipeSpawner extends GameBehavior {
  positions = [
    {
      up: new Vector3(0, -3, 0),
      down: new Vector3(0, 12, 0),
      collider: new Vector3(0, 0, 0)
    },
    {
      up: new Vector3(0, -5, 0),
      down: new Vector3(0, 10, 0),
      collider: new Vector3(0, 0, 0)
    },
    {
      up: new Vector3(0, -7, 0),
      down: new Vector3(0, 8, 0),
      collider: new Vector3(0, 0, 0)
    },
    {
      up: new Vector3(0, -9, 0),
      down: new Vector3(0, 6, 0),
      collider: new Vector3(0, 0, 0)
    },
    {
      up: new Vector3(0, -10, 0),
      down: new Vector3(0, 5, 0),
      collider: new Vector3(0, 0, 0)
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

  fixedUpdate() {
  }

  spawn() {
    const min = Math.ceil(0);
    const max = Math.floor(4);
    const index = Math.floor(Math.random() * (max - min + 1)) + min;
    this.pipeParent = SceneManager.activeScene.instantiate(GameObject, new Vector3(18, 0, 0), null);

    const colliderObj = SceneManager.activeScene.instantiate(GameObject, new Vector3(14, 0, 0), null);
    colliderObj.addBehavior(RigidBody).init({mass: 0, isKinematic: true});
    colliderObj.addBehavior(SpriteRenderer).init({sprite: spritey, rendererPriority: 1, color: [1,1,1,1]});
    colliderObj.addBehavior(BoxCollider).init({size: new Vector3(2, 10, 2)});

    const up = SceneManager.activeScene.instantiate(PipeUp, new Vector3(18, 0, 0), this.pipeParent.transform);
    const down = SceneManager.activeScene.instantiate(PipeDown, new Vector3(18, 0, 0), this.pipeParent.transform);

    up.transform.localPosition = this.positions[index].up;
    down.transform.localPosition = this.positions[index].down;
    colliderObj.transform.localPosition = this.positions[index].collider;
  }
}
