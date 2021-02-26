import TransformTestObject from "../gameObjects/TransformTestObject";
import CameraObject from "../../engine/CameraObject";
import { Vector3 } from "../../engine/Vector3";

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

const testObj = {
  sceneId: 1,
  type: TransformTestObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, 0),
      },
    },
  },
}


export default {
  gameObjects: [cameraObj, testObj],
};
