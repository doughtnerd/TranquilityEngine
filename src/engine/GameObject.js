const Transform = require('./Transform');

class GameObject {

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
