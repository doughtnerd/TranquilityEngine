const Collider = require("./physics/Collider");
const SAP = require("./physics/SAP");
const RigidBody = require("./RigidBody");
const SceneManager = require("./SceneManager");

class PhysicsEngine {
  static rigidBodies = [];
  static sap;

  static fixedUpdate() {
    SceneManager.activeScene.findObjectsOfType(RigidBody).forEach((b) => {
      b.fixedUpdate()
    });

    const colliders = SceneManager.activeScene.findObjectsOfType(Collider);
    PhysicsEngine.sap = new SAP(colliders);
    
    PhysicsEngine.sap.fixedUpdate();

  }
}

module.exports = PhysicsEngine;
