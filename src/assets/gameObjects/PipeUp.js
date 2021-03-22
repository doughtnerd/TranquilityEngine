import BoxCollider from "../../engine/physics/BoxCollider";
import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import { Vector3 } from "../../engine/Vector3";
import pipeSprite from "../images/PipeUp.png";
import RigidBody from "../../engine/physics/RigidBody";

export default PipeUp = {
  type: GameObject,
  attributes: {
    name: "PipeUp"
  },
  behaviors: {
    Transform: {
      scale: new Vector3(2, 10, 1)
    },
    SpriteRenderer: {
      type: SpriteRenderer,
      attributes: {
        sprite: pipeSprite,
        color: [1, 1, 1, 1],
        rendererPriority: 2000,
      }
    },
    RigidBody: {
      type: RigidBody,
      attributes: {
        mass: 0, 
        useGravity: false,
      }
    },
    BoxCollider: {
      type: BoxCollider,
      attributes: {
        size: new Vector3(2, 10, 2),
        isTrigger: false,
        collisionLayer: 0x0000000000000001,
      }
    }
  }
}

// export default class PipeUp extends GameObject {
//   constructor(name = "PipeUp") {
//     super(name);

//     this.transform.scale = new Vector3(2, 10, 1);

//     this.addBehavior(SpriteRenderer).init({
//       sprite: pipeSprite,
//       color: [1, 1, 1, 1],
//       rendererPriority: 2000,
//     });
//     this.addBehavior(RigidBody).init({ mass: 0, useGravity: false });
//     this.addBehavior(BoxCollider).init({
//       size: new Vector3(2, 10, 2),
//       isTrigger: false,
//       collisionLayer: 0x0000000000000001,
//     });
//   }
// }
