const GameObject = require("../../engine/GameObject");
const CameraObject = require("../../engine/CameraObject");
const PlayerObject = require("../gameObjects/PlayerObject");
const { Vector3 } = require("../../engine/Vector3");

const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, -6),
        // position: new Vector3(0, 0, 6),
        // rotation: {
        //   x: 0,
        //   y: 180,
        //   z: 0
        // }
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 90,
        targetDisplayIndex: 0
      }
    }
  },
};

const cameraObj2 = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, -6),
        // position: new Vector3(0, 0, 6),
        // rotation: {
        //   x: 0,
        //   y: 180,
        //   z: 0
        // }
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 90,
        targetDisplayIndex: 1
      }
    }
  },
};

const customObj = {
  sceneId: 1,
  type: GameObject,
  attributes: {
    name: "Custom",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, 0),
        scale: new Vector3(1, 1, 1)
      },
    },
    RigidBody: {
      type: require("../../engine/RigidBody"),
      attributes: {
        static: true
      }
    },
    SpriteRenderer: {
      type: require("../../engine/rendering/SpriteRenderer"),
      attributes: {
        rendererPriority: 1000,
        sprite: require("../images/moderncraft.png"),
        color: [1, 1, 1, 1],
        // material: new SpriteDefaultMaterial(),
      },
    },
    BoxCollider: {
      type: require("../../engine/BoxCollider"),
    },
  },
};

const playerObj = {
  sceneId: 2,
  type: PlayerObject,
  attributes: {
    name: "Chris",
    tags: ["Player"],
  },
  behaviors: {
    RigidBody: {
      type: require("../../engine/RigidBody"),
      attributes: {
        mass: 10,
        useGravity: true
      }
    },
    BoxCollider: {
      type: require("../../engine/BoxCollider"),
    },
    Damager: {
      attributes: {
        damageAmount: 1,
      },
    },
    Transform: {
      attributes: {
        position: new Vector3(0, 6, 0),
        scale: Vector3.one,
      },
    },
    SpriteRenderer: {
      attributes: {
        sprite: require("../images/flappy-bird-1.png"),
        color: [1, 1, 1, 1],
        // material: new SpriteDefaultMaterial(),
      },
    },
  },
};

module.exports = {
  gameObjects: [cameraObj, customObj, playerObj],
};
