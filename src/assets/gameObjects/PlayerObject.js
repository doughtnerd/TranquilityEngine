import BoxCollider from "../../engine/physics/BoxCollider";
import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import RigidBody from "../../engine/physics/RigidBody";
import Damageable from "../behaviors/Damageable";
import MoveObject from "../behaviors/MoveObject";
import VelocityBasedRotation from "../behaviors/VelocityBasedRotation";
import flappyBird from "../images/flappyBird.png";
import { Vector3 } from "../../engine/Vector3";

export const Player = {
  type: GameObject,
  attributes: {
    name: "Player",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, 0),
        scale: new Vector3(2, 2, 1),
      },
    },
    Damageable: {
      type: Damageable,
      attributes: {
        health: 1
      },
    },
    SpriteRenderer: {
      type: SpriteRenderer,
      attributes: {
        sprite: flappyBird,
        color: [1, 1, 1, 1],
        rendererPriority: 1000,
      }
    },
    RigidBody: {
      type: RigidBody,
      attributes: {
        mass: 0, 
        useGravity: false,
        constraints: {
          freezePosition: {
            x: false,
            y: false,
            z: true
          },
          freezeRotation: {
            x: true,
            y: true,
            z: true
          }
        }
      }
    },
    BoxCollider: {
      type: BoxCollider,
      attributes: {
        size: new Vector3(1, 1, 1),
        collisionLayer: 0x0000000000000111,
      }
    },
    VelocityBasedRotation: {
      type: VelocityBasedRotation,
    }
  },
};

export default class PlayerObject extends GameObject {
  constructor(name = "Player") {
    super(name);

    this.transform.scale = new Vector3(2, 2, 1);
    this.addBehavior(Damageable).init({ health: 1 });
    this.addBehavior(SpriteRenderer).init({
      sprite: flappyBird,
      color: [1, 1, 1, 1],
      rendererPriority: 1000,
    });
    this.addBehavior(MoveObject);
    this.addBehavior(RigidBody).init({ 
      mass: 0, 
      useGravity: false,
      constraints: {
        freezePosition: {
          x: false,
          y: false,
          z: true
        },
        freezeRotation: {
          x: true,
          y: true,
          z: true
        }
      }
    });
    this.addBehavior(BoxCollider).init({
      size: new Vector3(1, 1, 1),
      collisionLayer: 0x0000000000000111,
    });
    this.addBehavior(VelocityBasedRotation);
  }
}
