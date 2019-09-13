class GameObject {

  name;
  tags = [];
  behaviors = new Map();

  constructor(name) {
    this.name = name;
  }

  getBehavior(behaviorType) {
    return this.behaviors.get(behaviorType);
  }

  getBehaviors() {
    const arr = [];
    this.behaviors.forEach(b => arr.push(b));
    return arr;
  }

  addBehavior(behaviorType) {
    const behavior = new behaviorType(this);
    this.behaviors.set(behaviorType, behavior);
    return behavior;
  }

  static dontDestroyOnLoad(GameObject) {

  }

  static instantiate(gameObjectConstructor) {

  }
}

module.exports = GameObject;
