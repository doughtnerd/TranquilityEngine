import { Vector3 } from "../Vector3";
import Collider from "./Collider";
import RigidBody from "./RigidBody";
import {Box, Vec3} from 'cannon';

export default class BoxCollider extends Collider {
    attachedRigidBody = null;
    bounds;
    contactOffset;
    enabled = true;
    isTrigger = false;
    material = null;
    sharedMaterial = false; 
    center = null;
    _size = Vector3.one

    shape: Box = null;

    get size(): Vector3 {
      return this._size
    }

    set size(size) {
      this._size = size;
      if(this.shape) {
        this.shape.halfExtents = new Vec3(this.size.x / 2, this.size.y / 2, this.size.z / 2);
        this.shape.updateBoundingSphereRadius();
        this.shape.updateConvexPolyhedronRepresentation();
      }
    }

    awake() {
      this.shape = new Box(new Vec3(this.size.x / 2, this.size.y / 2, this.size.z / 2));

      if(this.isTrigger) {
        this.shape.collisionResponse = false;
      } else {
        this.shape.collisionResponse = true;
      }

      const rigid = this.gameObject.getBehavior(RigidBody);
      if(rigid) {
        rigid.body.addShape(this.shape);
        this.attachedRigidBody = rigid;
      }
    }

    onDestroy() {
      // console.log(this.attachedRigidBody.shapes);
      // this.attachedRigidBody?.body.shapes.splice(this.attachedRigidBody.body.shapes.indexOf(this.shape), 1);
    }
}