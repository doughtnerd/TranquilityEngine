import Scene from "./Scene";
import SceneManager from "./SceneManager";
import Transform from "./Transform";
import { Vector3 } from "./Vector3";

export default class GameObject {
  public name;
  public tags = [];
  public behaviors = new Map();
  public transform;
  public scene: Scene;

  private awakeCalled: boolean = false;

  constructor(name) {
    this.name = name;
    this.addBehavior(Transform);
    this.transform = this.getBehavior(Transform);
  }

  broadcastMessage(message: string, messageParam?: any) {
    if(message = 'awake') {
      this.awakeCalled = true;
    }
    this.getBehaviors().forEach(b => {
      b[message]?.(messageParam);
    })
  }

  getBehavior<T>(behaviorType: T): T | any {
    if (typeof behaviorType !== "string") {
      behaviorType = behaviorType['name'];
    }

    return this.behaviors.get(behaviorType);
  }

  getBehaviors() {
    const arr = [];
    this.behaviors.forEach((b) => arr.push(b));
    return arr;
  }

  addBehavior<T>(behaviorType: T): T {
    const behavior = new (behaviorType as any)(this);
    this.behaviors.set((behaviorType as any).name, behavior);
    behavior.awake();
    return behavior as T;
  }

  static dontDestroyOnLoad(GameObject) {}

  static instantiate(gameObjectConstructor, position = Vector3.zero, parentTransform = null) {
    throw new Error("Not implemented");
    // SceneManager.activeScene.instantiate(gameObjectConstructor, parentTransform)
    // const gameObj = new gameObjectConstructor();
    // gameObj.transform.setParent(parentTransform);
    // return gameObj;
  }
}
