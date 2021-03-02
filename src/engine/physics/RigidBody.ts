import GameBehavior from "../GameBehavior";
import { Vector3 } from "../Vector3";

import PhysicsEngine from "../PhysicsEngine";
import {Body, Vec3, Quaternion} from 'cannon';

export default class RigidBody extends GameBehavior {
  isKinematic: boolean = false;
  useGravity: boolean = true;
  mass: number = 1;
  drag: number = 0;
  angularDrag: number = 0.05;
  interpolate = null;
  collisionDetection = null;
  constraints = {
    freezePosition: {
      x: false,
      y: false,
      z: false
    },
    freezeRotation: {
      x: false,
      y: false,
      z: false
    }
  };
  velocity: Vector3 = Vector3.zero;

  body: Body = null;

  awake() {
    this.body = new Body({
      mass: this.mass,
      linearDamping: this.drag,
      angularDamping: this.angularDrag,
      position: new Vec3(this.transform.position.x, this.transform.position.y, this.transform.position.z),
      type: this.isKinematic ? Body.KINEMATIC : Body.DYNAMIC,
    });
    this.body.addEventListener("collide", (e) => { console.log(`${this.gameObject.name} collided`, e); } );

    PhysicsEngine.addRigidBody(this.body);
  }

  onDestroy() {
    if(this.body) {
      PhysicsEngine.removeRigidBody(this.body);
    }
  }

  update() {
    if(!this.body) return;
    this.body.position = new Vec3(this.transform.position.x, this.transform.position.y, this.transform.position.z);
  }
  
  fixedUpdate() {
    if(!this.body) return;

    if(this.constraints.freezePosition.x) {
      this.body.position.x = this.transform.position.x;
      this.body.velocity.x = 0;
    } 
    
    if(this.constraints.freezePosition.y) {
      this.body.position.y = this.transform.position.y;
      this.body.velocity.y = 0;
    } 
    
    if(this.constraints.freezePosition.z) {
      this.body.position.z = this.transform.position.z;
      this.body.velocity.z = 0;
    } 

    this.transform.position = new Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z
    );

    const quatForUpdate: Quaternion = new Quaternion().setFromEuler(this.transform.rotation.x, this.transform.rotation.y, this.transform.rotation.z);
    if(this.constraints.freezeRotation.x) {
      this.body.quaternion.x = quatForUpdate.x
      this.body.angularVelocity.x = 0;
    } 
    
    if(this.constraints.freezeRotation.y) {
      this.body.quaternion.y = quatForUpdate.y;
      this.body.angularVelocity.y = 0;
    } 
    
    if(this.constraints.freezeRotation.z) {
      this.body.quaternion.z = quatForUpdate.z;
      this.body.angularVelocity.z = 0;
    } 

    const receiver: Vec3 = new Vec3();
    this.body.quaternion.toEuler(receiver);
    this.transform.rotation = new Vector3(
      receiver.x,
      receiver.y,
      receiver.z
    );
  }

  addForce(force, mode) {
    switch(mode) {
      case 'force':
        this.body.applyLocalForce(new Vec3(force.x, force.y, force.z), new Vec3(0,0,0));
        break;
      case 'impulse':
        this.body.applyLocalImpulse(new Vec3(force.x, force.y, force.z), new Vec3(0,0,0));
        break;
    }
  }


}
