import Collider from "./Collider";
import * as uuid from "uuid";
//Sweep and prune collision system
export default class SAP {
  colliders = [];

  endpointsX = [];
  endpointsY = [];
  endpointsZ = [];

  collidingPairs = [];

  worldCollisions = [];

  constructor(colliders = []) {
    colliders.forEach((c) => this.addCollider(c));
  }

  checkCollisions() {
    this.colliders.forEach((col) => col.fixedUpdate());

    this.sortEndpoints(this.endpointsX);
    this.sortEndpoints(this.endpointsY);
    this.sortEndpoints(this.endpointsZ);

    const previousWorldCollisions = this.worldCollisions;
    const allWorldCollisions = [];
    const enterWorldCollisions = [];
    const exitWorldCollisions = [];
    const stayWorldCollisions = [];



    for (let i = 0; i < this.collidingPairs.length; i++) {
      const { a, b, id } = this.collidingPairs[i];
      const testResult = Collider.AABBAABB(a, b);
      if (testResult.isIntersecting) {
        // console.log(a.gameObject.name, b.gameObject.name, testResult);
        const existing = previousWorldCollisions.find((item) => {
          return item.id === id;
        });

        const collision = { ...testResult, a, b, id };
        allWorldCollisions.push(collision);

        if (existing) {
          stayWorldCollisions.push(collision);
        } else {
          enterWorldCollisions.push(collision);
        }
      }
    }

    this.worldCollisions = allWorldCollisions;

    return { enterWorldCollisions, exitWorldCollisions, stayWorldCollisions, allWorldCollisions };
  }

  addCollider(collider) {
    if (this.colliders.includes(collider)) {
      return;
    }
    this.colliders.push(collider);

    this.endpointsX = this.endpointsX.concat(collider.endpoints.x);
    this.sortEndpoints(this.endpointsX);

    this.endpointsY = this.endpointsY.concat(collider.endpoints.y);
    this.sortEndpoints(this.endpointsY);

    this.endpointsZ = this.endpointsZ.concat(collider.endpoints.z);
    this.sortEndpoints(this.endpointsZ);
  }

  removeCollider(collider) {

    const [colToRemove] = this.colliders.splice(this.colliders.indexOf(collider), 1);

    colToRemove.endpoints.x.forEach(e => this.endpointsX.splice(this.endpointsX.indexOf(e), 1))
    this.sortEndpoints(this.endpointsX);
    
    colToRemove.endpoints.y.forEach(e => this.endpointsY.splice(this.endpointsY.indexOf(e), 1))
    this.sortEndpoints(this.endpointsY);
    
    colToRemove.endpoints.z.forEach(e => this.endpointsZ.splice(this.endpointsZ.indexOf(e), 1))
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
              return !((pair.a === ep0.collider && pair.b === ep1.collider) || (pair.a === ep1.collider && pair.b === ep0.collider));
            });
          }
        } else {
          if (ep1.isMin) {
            this.collidingPairs.push({
              id: uuid.v4(),
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
