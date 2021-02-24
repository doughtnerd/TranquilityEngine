const Collider = require("./physics/Collider");
const SAP = require("./physics/SAP");
const RigidBody = require("./RigidBody");
const SceneManager = require("./SceneManager");

class PhysicsEngine {
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
      // console.log(enterWorldCollisions, exitWorldCollisions, stayWorldCollisions);
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

module.exports = PhysicsEngine;
