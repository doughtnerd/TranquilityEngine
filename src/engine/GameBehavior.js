export default class GameBehavior {
  _isActive = false;

  constructor(gameObject) {
    this.gameObject = gameObject;
    this.transform = this.gameObject.transform;
  }

  init(properties) {
    for (const key in properties) {
      if (this.hasOwnProperty(key) || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), key)?.set) {
        this[key] = properties[key];
      } else {
        console.log(`${this.constructor.name} does not have property ${key}`);
      }
    }
    return this;
  }

  setActive(isActive) {
    if (isActive) {
      this.onEnable();
    } else {
      this.onDisable();
    }
    this.isActive = isActive;
  }

  get isActive() {
    return this._isActive;
  }

  onTriggerEnter() {}
  onTriggerExit() {}

  //#region First Scene Load
  awake() {}
  onEnable() {}
  //#endregion

  //#region Before first frame
  start() {}
  //#endregion

  //#region Update Functions
  fixedUpdate() {}
  update() {}
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
