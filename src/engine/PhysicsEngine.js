import Collider from "./physics/Collider";
import SAP from "./physics/SAP";
import RigidBody from "./RigidBody";
import SceneManager from "./SceneManager";

export default class PhysicsEngine {
  static sap = new SAP();

  static rigidBodies = [];

  static fixedUpdate() {
    SceneManager.activeScene.findObjectsOfType(RigidBody).forEach((b) => {
      b.fixedUpdate();
    });
    
    const historicalCollisions = PhysicsEngine.sap.checkCollisions();
    PhysicsEngine.handleCollisions(historicalCollisions);
  }

  static handleCollisions({ enterWorldCollisions, exitWorldCollisions, stayWorldCollisions }) {
    enterWorldCollisions.forEach(({ a, b, nEnter, penetration, isIntersecting }) => {
      if (a.isTrigger) {
        b.gameObject.getBehaviors().forEach((behavior) => behavior.onTriggerEnter(a));
      }
      
      if (b.isTrigger) {
        console.log(enterWorldCollisions, exitWorldCollisions, stayWorldCollisions);
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

  static addCollider(collider) {
    PhysicsEngine.sap.addCollider(collider);
  }

  static removeCollider(collider) {
    PhysicsEngine.sap.removeCollider(collider);
  }
}
