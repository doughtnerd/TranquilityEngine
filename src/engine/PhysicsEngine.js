const SAP = require("./physics/SAP");

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
    PhysicsEngine.rigidBodies.forEach((o) => {
      o.getBehaviors().forEach((b) => b.fixedUpdate());
    });

    PhysicsEngine.sap.fixedUpdate();
  }
}

module.exports = PhysicsEngine;
