const GameBehavior = require("../../engine/GameBehavior");
const SceneManager = require("../../engine/SceneManager");
const Time = require("../../engine/Time");
const { Vector3 } = require("../../engine/Vector3");

class InfiniteScroller extends GameBehavior {
  backgroundToSpawn;
  startPos = Vector3.zero;
  rightBound = 32;
  scrollVelocity = new Vector3(-5, 0, 0);
  activeScroller;
  previousScroller;

  awake() {
    this.activeScroller = new this.backgroundToSpawn();
    this.activeScroller.transform.position = this.startPos;
    SceneManager.activeScene.instantiate(this.activeScroller);
  }

  update() {
    this.activeScroller.transform.position = Vector3.add(
      this.activeScroller.transform.position,
      Vector3.scale(this.scrollVelocity, Time.deltaTime)
    );
    const currentRightBound = Vector3.add(this.activeScroller.transform.position, this.activeScroller.transform.scale).x;

    if (this.previousScroller) {
      this.previousScroller.transform.position = Vector3.add(
        this.previousScroller.transform.position,
        Vector3.scale(this.scrollVelocity, Time.deltaTime)
      );
    }

    if (currentRightBound < this.rightBound) {
      if (this.previousScroller) {
        SceneManager.activeScene.destroy(this.previousScroller);
      }
      this.previousScroller = this.activeScroller;
      this.activeScroller = new this.backgroundToSpawn();
      this.activeScroller.transform.position = Vector3.add(this.startPos, new Vector3(this.rightBound - 0.5, 0, 0));
      SceneManager.activeScene.instantiate(this.activeScroller);
    }
  }
}

module.exports = InfiniteScroller;
