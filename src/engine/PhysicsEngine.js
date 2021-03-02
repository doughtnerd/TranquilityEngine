import * as Cannon from 'cannon';
import SceneManager from './SceneManager';
import Time from './Time';

export default class PhysicsEngine {

  static world = null;

  static initialize() {
    PhysicsEngine.world = new Cannon.World();
    PhysicsEngine.world.gravity = new Cannon.Vec3(0, -9.82, 0)
  }

  static fixedUpdate() {
    PhysicsEngine.world.step(1.0/60.0, Time.fixedDeltaTime, 3);
    SceneManager.activeScene.fixedUpdate();
  }

  static handleCollisions({ enterWorldCollisions, exitWorldCollisions, stayWorldCollisions }) {
  
  }

  static addRigidBody(body) {
    this.world.addBody(body);
  }

  static removeRigidBody(body) {
    this.world.removeBody(body);
  }

}
