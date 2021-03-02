import GameBehavior from "../../engine/GameBehavior";
import RigidBody from "../../engine/physics/RigidBody";
import SceneManager from "../../engine/SceneManager";
import Time from "../../engine/Time";
import { Vector3 } from "../../engine/Vector3";

export default class InfiniteScroller extends GameBehavior {
  backgroundToSpawn = null;
  startPos = Vector3.zero;
  rightBound = 32;
  scrollVelocity = new Vector3(-5, 0, 0);
  activeScroller = null;
  previousScroller = null;

  awake() {
    this.activeScroller = SceneManager.activeScene.instantiate(this.backgroundToSpawn);
    this.activeScroller.transform.position = this.startPos;
  }

  fixedUpdate() {
    // console.log(this.gameObject.getBehavior(RigidBody)?.body.position);
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
      this.activeScroller = SceneManager.activeScene.instantiate(this.backgroundToSpawn);
      this.activeScroller.transform.position = Vector3.add(this.startPos, new Vector3(this.rightBound - 0.5, 0, 0));
    }
  }
}
