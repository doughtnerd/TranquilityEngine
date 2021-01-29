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

  //#region First Scene Load
  awake() { }
  onEnable() {}
  //#endregion

  //#region Before first frame
  start() { }
  //#endregion

  //#region Update Functions
  fixedUpdate() { }
  update() { }
  lateUpdate() {}
  //#endregion

  //#region Object Destroyed
  onDestroy() {}
  //#endregion

  //#region When Quitting
  onDisable() {}
  //#endregion

  //#region Rendering lifecycle
  onPreCull() {}
  onBecameVisible() {}
  onBecameInvisible() {}
  onWillRenderObject() {}
  onPreRender() {}
  onRenderObject() {}
  onPostRender() {}
  onRenderImage() {}
  onGUI() {}
  onDrawGizmos() {}
  //#endregion

}

module.exports = GameBehavior;
