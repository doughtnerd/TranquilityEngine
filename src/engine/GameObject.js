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

  getBehavior(behaviorType) {
    if (typeof behaviorType !== "string") {
      behaviorType = behaviorType.name;
    }

    return this.behaviors.get(behaviorType);
  }

  getBehaviors() {
    const arr = [];
    this.behaviors.forEach((b) => arr.push(b));
    return arr;
  }

  addBehavior(behaviorType) {
    console.debug("---Adding behavior: ", behaviorType);

    let behavior;
    try {
      console.debug("---Attempting to create behavior: ", behaviorType);
      behavior = new behaviorType(this);
    } catch (e) {
      console.debug("---Failed first attempt, trying method 2: ", behaviorType);
      behavior = new behaviorType[behaviorType](this);
    }
    this.behaviors.set(behaviorType.name, behavior);
    return behavior;
  }

  static dontDestroyOnLoad(GameObject) {}

  static instantiate(gameObjectConstructor, parentTransform = null) {
    const gameObj = new gameObjectConstructor();
    gameObj.transform.setParent(parentTransform);
    return gameObj;
  }
}
