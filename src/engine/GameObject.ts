import Transform from "./Transform";

export default class GameObject {
  name;
  tags = [];
  behaviors = new Map();
  transform;

  constructor(name) {
    this.name = name;
    this.addBehavior(Transform);
    this.transform = this.getBehavior(Transform);
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
    console.debug("---Adding behavior: ", behaviorType);

    let behavior;
    try {
      console.debug("---Attempting to create behavior: ", behaviorType);
      behavior = new (behaviorType as any)(this);
    } catch (e) {
      console.debug("---Failed first attempt, trying method 2: ", behaviorType);
      behavior = new (behaviorType as any)[behaviorType](this);
    }
    this.behaviors.set((behaviorType as any).name, behavior);
    return behavior as T;
  }

  static dontDestroyOnLoad(GameObject) {}

  static instantiate(gameObjectConstructor, parentTransform = null) {
    const gameObj = new gameObjectConstructor();
    gameObj.transform.setParent(parentTransform);
    return gameObj;
  }
}
