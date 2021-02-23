const GameObject = require("../../engine/GameObject");
const CameraObject = require("../../engine/CameraObject");
const PlayerObject = require("../gameObjects/PlayerObject");
const { Vector3 } = require("../../engine/Vector3");
const  Ground = require("../gameObjects/Ground");
const  Background = require("../gameObjects/Background");

const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, -10)
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 90,
        targetDisplayIndex: 0,
        projection: 'orthographic'
      }
    }
  },
};

const playerObj = {
  sceneId: 2,
  type: PlayerObject,
  attributes: {
    name: "Player",
    tags: ["Player"],
  },
  behaviors: {
    RigidBody: {
      type: require("../../engine/RigidBody"),
      attributes: {
        mass: 20,
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
        position: new Vector3(0, 2, 0),
        scale: new Vector3(2, 2, 1)
      },
    },
    SpriteRenderer: {
      attributes: {
        sprite: require("../images/flappy-bird-1.png"),
        color: [1, 1, 1, 1],
        rendererPriority: 2000
        // material: new SpriteDefaultMaterial(),
      },
    },
  },
};

const infiniteGround = {
  sceneId: 3,
  type: GameObject,
  attributes: {
    name: "Ground",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, -13, 0),
        scale: new Vector3(30, 10, 0),
      },
    },
    RigidBody: {
      type: require("../../engine/RigidBody"),
      attributes: {
        static: true
      }
    },
    BoxCollider: {
      type: require("../../engine/BoxCollider"),
      attributes: {
        bounds: {
          size: [30, 5, 1]
        }
      }
    },
    InfiniteBackground: {
      type: require("../../assets/behaviors/InfiniteBackground"),
      attributes: {
        startPos: new Vector3(0, -13, 0),
        backgroundToSpawn: Ground
      }
    }
  },
};

const infiniteBackground = {
  sceneId: 3,
  type: GameObject,
  attributes: {
    name: "Ground",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 3, 3),
        scale: new Vector3(32, 25, 0),
      },
    },
    InfiniteBackground: {
      type: require("../../assets/behaviors/InfiniteBackground"),
      attributes: {
        startPos: new Vector3(0, 3, 5),
        backgroundToSpawn: Background,
        scrollVelocity: new Vector3(-.5, 0, 0),
        rightBound: 30
      }
    }
  },
};

module.exports = {
  gameObjects: [
    cameraObj, 
    playerObj, 
    infiniteGround,
    infiniteBackground
  ],
};
