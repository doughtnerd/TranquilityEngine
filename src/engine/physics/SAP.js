const RigidBody = require("../RigidBody");
const { Vector3 } = require("../Vector3");
const Collider = require("./Collider");
// const RigidBody = require("../RigidBody");

//Sweep and prune collision system
class SAP {
  colliders = [];

  endpointsX = [];
  endpointsY = [];
  endpointsZ = [];

  collidingPairs = [];

  constructor(colliders = []) {
    colliders.forEach(c => this.addCollider(c));
  }

  fixedUpdate() {
    this.colliders.forEach((col) => col.fixedUpdate());

    this.sortEndpoints(this.endpointsX);
    this.sortEndpoints(this.endpointsY);
    this.sortEndpoints(this.endpointsZ);

    this.collidingPairs.forEach((pair) => {
      const testResult = Collider.AABBAABB(pair.a, pair.b);

      if(testResult.isIntersecting) {
        // console.log(pair.a.gameObject.name, pair.b.gameObject.name, testResult.penetration.toFixed(2), testResult.nEnter.toArray());
        const aRigid = pair.a.gameObject.getBehavior(RigidBody);
        const bRigid = pair.b.gameObject.getBehavior(RigidBody);

        aRigid.velocity = Vector3.zero;
        bRigid.velocity = Vector3.zero;
      }
    })

    // this.collidingPairs.forEach((pair) => {
    //   const isOverlapping = Collider.testAABBOverlap(pair.a, pair.b);

      
    //   if (isOverlapping) {
    //     console.log(pair.a.endpoints.x[0].value, pair.b.endpoints.x[0].value);
    //     // console.log(`Collision detected: `, pair.a.gameObject.name, pair.b.gameObject.name);

    //     const aRigid = pair.a.gameObject.getBehavior(RigidBody);
    //     const bRigid = pair.b.gameObject.getBehavior(RigidBody);
        
    //     const aVel = aRigid.velocity;
    //     const bVel = bRigid.velocity;

    //     const aOpposite = Vector3.scale(aVel, -200);
    //     const bOpposite = Vector3.scale(bVel, -200);

    //     aRigid.addForce(Vector3.add(aOpposite, bVel), 'impulse');
    //     bRigid.addForce(Vector3.add(bOpposite, aVel), 'impulse');
    //   }
    // });
  }

  addCollider(collider) {
    this.colliders.push(collider);

    this.endpointsX = this.endpointsX.concat(collider.endpoints.x);
    this.sortEndpoints(this.endpointsX);

    this.endpointsY = this.endpointsY.concat(collider.endpoints.y);
    this.sortEndpoints(this.endpointsY);

    this.endpointsZ = this.endpointsZ.concat(collider.endpoints.z);
    this.sortEndpoints(this.endpointsZ);
  }

  sortEndpoints(endpoints) {
    const length = endpoints.length;
    for (let i = 1; i < length; i++) {
      const currentEndpoint = endpoints[i];

      let j = i - 1;
      while (j >= 0 && endpoints[j].value > currentEndpoint.value) {
        const ep0 = endpoints[j];
        const ep1 = currentEndpoint;

        if (ep0.isMin) {
          if (!ep1.isMin) {
            this.collidingPairs = this.collidingPairs.filter((pair) => {
              return !(
                (pair.a === ep0.collider && pair.b === ep1.collider) ||
                (pair.a === ep1.collider && pair.b === ep0.collider)
              );
            });
          }
        } else {
          if (ep1.isMin) {
            this.collidingPairs.push({
              a: ep0.collider,
              b: ep1.collider,
            });
          }
        }

        endpoints[j + 1] = endpoints[j];
        endpoints[j] = currentEndpoint;
        j = j - 1;
      }
    }
  }
}

module.exports = SAP;
