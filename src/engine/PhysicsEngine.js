import Collider from "./physics/Collider";
import SAP from "./physics/SAP";
import RigidBody from "./RigidBody";
import SceneManager from "./SceneManager";

export default class PhysicsEngine {
  static sap = new SAP();

  static fixedUpdate() {
    SceneManager.activeScene.findObjectsOfType(RigidBody).forEach((b) => {
      b.fixedUpdate();
    });

    const colliders = SceneManager.activeScene.findObjectsOfType(Collider);
    colliders.forEach((c) => PhysicsEngine.sap.addCollider(c));
    const historicalCollisions = PhysicsEngine.sap.checkCollisions(colliders);

    PhysicsEngine.handleCollisions(historicalCollisions);
  }

  static handleCollisions({ enterWorldCollisions, exitWorldCollisions, stayWorldCollisions }) {
    enterWorldCollisions.forEach(({ a, b, nEnter, penetration, isIntersecting }) => {
      // console.debug(enterWorldCollisions, exitWorldCollisions, stayWorldCollisions);
      if (a.isTrigger) {
        b.gameObject.getBehaviors().forEach((behavior) => behavior.onTriggerEnter(a));
      }

      if (b.isTrigger) {
        a.gameObject.getBehaviors().forEach((behavior) => behavior.onTriggerEnter(b));
      }
    });

    exitWorldCollisions.forEach(({ a, b, nEnter, penetration, isIntersecting }) => {
      if (a.isTrigger) {
        a.gameObject.getBehaviors().forEach((behavior) => behavior.onTriggerExit(b));
      }

      if (b.isTrigger) {
        b.gameObject.getBehaviors().forEach((behavior) => behavior.onTriggerExit(a));
      }
    });
  }
}
