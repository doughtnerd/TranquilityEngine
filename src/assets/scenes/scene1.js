const GameObject = require("../../engine/GameObject");
const CameraObject = require("../../engine/CameraObject");
const PlayerObject = require("../gameObjects/PlayerObject");
const { Vector3 } = require("../../engine/Vector3");
const Ground = require("../gameObjects/Ground");
const Background = require("../gameObjects/Background");
const PipeDown = require("../gameObjects/PipeDown");
const PipeUp = require("../gameObjects/PipeUp");

const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, -10),
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 90,
        targetDisplayIndex: 0,
        projection: "orthographic",
      },
    },
  },
};

const playerObj = {
  sceneId: 1,
  type: PlayerObject,
  attributes: {
    name: "Player",
    tags: ["Player"],
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(-2, 2, 0),
        scale: new Vector3(2, 2, 1),
      },
    },
  },
};

const infiniteGround = {
  sceneId: 2,
  type: GameObject,
  attributes: {
    name: "Ground",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, -13, -1),
        scale: new Vector3(30, 10, 0),
      },
    },
    RigidBody: {
      type: require("../../engine/RigidBody"),
      attributes: {
        static: true,
      },
    },
    BoxCollider: {
      type: require("../../engine/BoxCollider"),
      attributes: {
        bounds: {
          size: [30, 5, 1],
        },
      },
    },
    InfiniteBackground: {
      type: require("../behaviors/InfiniteScroller"),
      attributes: {
        startPos: new Vector3(0, -13, -1),
        backgroundToSpawn: Ground,
      },
    },
  },
};

const infiniteBackground = {
  sceneId: 3,
  type: GameObject,
  attributes: {
    name: "Background",
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 3, 0),
        scale: new Vector3(32, 25, 0),
      },
    },
    InfiniteScroller: {
      type: require("../behaviors/InfiniteScroller"),
      attributes: {
        startPos: new Vector3(0, 3, 0),
        backgroundToSpawn: Background,
        scrollVelocity: new Vector3(-0.5, 0, 0),
        rightBound: 30,
      },
    },
  },
};

// const pipeUp = {
//   sceneId: 4,
//   type: PipeUp,
//   behaviors: {
//     Transform: {
//       attributes: {
//         position: new Vector3(0, -10, 0),
//       },
//     },
//   },
// };

// const pipeDown = {
//   sceneId: 5,
//   type: PipeDown,
//   behaviors: {
//     Transform: {
//       attributes: {
//         position: new Vector3(0, 5, 0),
//       },
//     },
//   },
// };

const pipeSpanwer = {
  sceneId: 6,
  type: GameObject,
  behaviors: {
    PipeSpawner: {
      type: require("../../assets/behaviors/PipeSpawner"),
    },
  },
};

module.exports = {
  gameObjects: [cameraObj, playerObj, infiniteGround, infiniteBackground, pipeSpanwer],
};
