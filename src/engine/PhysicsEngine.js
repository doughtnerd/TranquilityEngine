const SAP = require("./physics/SAP");
const RigidBody = require("./RigidBody");
const SceneManager = require("./SceneManager");

class PhysicsEngine {
  static rigidBodies = [];
  static sap = new SAP();

  static addRigidBody(rigidBody) {
    PhysicsEngine.rigidBodies.push(rigidBody);
  }

  static addCollider(collider) {
    PhysicsEngine.sap.addCollider(collider);
  }

  static fixedUpdate() {
    // SceneManager.activeScene.getBehaviors(RigidBody);

    SceneManager.activeScene.findObjectsOfType(RigidBody).forEach((b) => {
      b.fixedUpdate()
    });

    PhysicsEngine.sap.fixedUpdate();
  }
}

module.exports = PhysicsEngine;
