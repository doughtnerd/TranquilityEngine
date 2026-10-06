import GameObject from "../../engine/GameObject";
import CameraObject from "../../engine/CameraObject";
import PlayerObject from "../gameObjects/PlayerObject";
import RigidBody from "../../engine/RigidBody";
import Transform from "../../engine/Transform";
import BoxCollider from "../../engine/BoxCollider";
import InfiniteScroller from "../behaviors/InfiniteScroller";
import PipeSpawner from "../behaviors/PipeSpawner";
import Ground from "../gameObjects/Ground";
import Background from "../gameObjects/Background";
import { Vector3 } from "../../engine/Vector3";
import Camera from "../../engine/rendering/Camera";
import AudioManager from "../behaviors/AudioManager";
import AudioPlayer from "../../engine/AudioPlayer";

const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      type: Transform,
      attributes: {
        position: new Vector3(0, 0, -10),
      },
    },
    Camera: {
      type: Camera,
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
      type: Transform,
      attributes: {
        position: new Vector3(-2, 0, 0),
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
      type: Transform,
      attributes: {
        position: new Vector3(0, -13, -1),
        scale: new Vector3(30, 10, 0),
      },
    },
    RigidBody: {
      type: RigidBody,
      attributes: {
        static: true,
      },
    },
    BoxCollider: {
      type: BoxCollider,
      attributes: {
        bounds: {
          size: [30, 5, 1],
        },

        // TODO: USING COLLISION LAYER LIKE THIS SEEMS TO HAVE CREATED A MEMORY LEAK
        collisionLayer: 0x0000000000000100,
      },
    },
    InfiniteScroller: {
      type: InfiniteScroller,
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
      type: Transform,
      attributes: {
        position: new Vector3(0, 3, 3),
        scale: new Vector3(32, 25, 0),
      },
    },
    InfiniteScroller: {
      type: InfiniteScroller,
      attributes: {
        startPos: new Vector3(0, 3, 3),
        backgroundToSpawn: Background,
        scrollVelocity: new Vector3(-0.5, 0, 0),
        rightBound: 30,
      },
    },
  },
};

const pipeSpanwer = {
  sceneId: 6,
  type: GameObject,
  attributes: {
    name: "Pipe Spawner",
  },
  behaviors: {
    PipeSpawner: {
      type: PipeSpawner,
    },
  },
};

const audio = {
  type: GameObject,
  behaviors: {
    Player: {
      type: AudioPlayer,
      attributes: {}
    },
    Audio: {
      type: AudioManager,
      attributes: {}
    }
  }
}

export default {
  gameObjects: [
    cameraObj,
    playerObj,
    infiniteGround,
    infiniteBackground,
    pipeSpanwer,
    audio
  ],
};
