class GameBehavior {

  constructor(gameObject) {
    this.gameObject = gameObject;
  }

  init(properties) {
    for (const key in properties) {
      if (this.hasOwnProperty(key)) {
        this[key] = properties[key];
      }
    }
    return this;
  }

  awake() { }
  start() { }
  update() { }
  fixedUpdate() { }
}

module.exports = GameBehavior;
