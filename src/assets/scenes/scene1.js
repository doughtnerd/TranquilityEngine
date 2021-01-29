const GameObject = require("../../engine/GameObject");
const CameraObject = require("../../engine/CameraObject");
const Controllers = require("../gameObjects/Controllers");
const AudioHost = require("../gameObjects/AudioHost");
const PlayerObject = require("../gameObjects/PlayerObject");
const MonsterBase = require("../gameObjects/MonsterBase");
const SpriteDefaultMaterial = require("../../engine/materials/SpriteDefaultMaterial");
const { Vector3 } = require("../../engine/Vector3");

const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, 0),
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 40
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
        position: new Vector3(2, 0, -2),
      },
    },
    RigidBody: {
      type: require("../../engine/RigidBody"),
    },
    SpriteRenderer: {
      type: require("../../engine/rendering/SpriteRenderer"),
      attributes: {
        sprite: require("../images/moderncraft.png"),
        color: [1, 1, 1, 1],
        material: new SpriteDefaultMaterial(),
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
    Damager: {
      attributes: {
        damageAmount: 1,
      },
    },
    Transform: {
      attributes: {
        position: new Vector3(0, 0, 0),
        scale: Vector3.one,
      },
    },
    SpriteRenderer: {
      attributes: {
        sprite: require("../images/flappy-bird-1.png"),
        color: [1, 1, 1, 1],
        material: new SpriteDefaultMaterial(),
      },
    },
  },
};

module.exports = {
  gameObjects: [cameraObj, customObj, playerObj],
};
