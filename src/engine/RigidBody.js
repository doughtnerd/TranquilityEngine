const GameBehavior = require('./GameBehavior');
const PhysicsEngine = require('./PhysicsEngine');
const Time = require('./Time');
const Physics = require('./Physics');

class RigidBody extends GameBehavior {

  useGravity = false;
  mass = 1;
  dragCoefficient = .01;
  angularDrag = .05;

  airDensity = 1;
  velocity = [0, 0, 0];
  angularVelocity = [0, 0, 0];
  maxLinearVelocity;
  maxAngularVelocity;

  inertiaTensor;

  awake() {
    PhysicsEngine.addRigidBody(this.gameObject);
    this.inertiaTensor = Physics.computeCuboidInertiaTensorMatrix(
      this.mass,
      this.gameObject.transform.scale.x,
      this.gameObject.transform.scale.y,
      this.gameObject.transform.scale.z
    );
  }

  fixedUpdate() {
    this.addTorque([0, 0, 1 * Time.deltaTime])
    if (this.useGravity) {
      this.updateGravity();
    }
  }

  addForce(forceVector) {
    const d = this.linearDrag;
    const acceleration = [(forceVector[0] - d[0]) / this.mass, (forceVector[1] - d[1]) / this.mass, (forceVector[2] - d[2]) / this.mass];
    this.velocity[0] += acceleration[0] * Time.deltaTime;
    this.velocity[1] += acceleration[1] * Time.deltaTime;
    this.velocity[2] += acceleration[2] * Time.deltaTime;
    this.gameObject.transform.position.x += this.velocity[0] * Time.deltaTime;
    this.gameObject.transform.position.y += this.velocity[1] * Time.deltaTime;
    this.gameObject.transform.position.z += this.velocity[2] * Time.deltaTime;
  }

  addTorque(torqueVector) {
    const angularAcceleration = [torqueVector[0] / this.inertiaTensor[0][0], torqueVector[1] / this.inertiaTensor[1][1], torqueVector[2] / this.inertiaTensor[2][2]];
    this.angularVelocity[0] += angularAcceleration[0];
    this.angularVelocity[1] += angularAcceleration[1];
    this.angularVelocity[2] += angularAcceleration[2];
    this.gameObject.transform.rotation.x += this.angularVelocity[0] * Time.deltaTime;
    this.gameObject.transform.rotation.y += this.angularVelocity[1] * Time.deltaTime;
    this.gameObject.transform.rotation.z += this.angularVelocity[2] * Time.deltaTime;
  }

  get weight() {
    /*
      Weight (gravitational force) is a function of mass * the gravitational force given off by an object.
      For earth, a constant of 9.8 is used event though gravity varies the farther/closer from/to an object you get.
    */
    return this.mass * Physics.GRAVITATIONAL_ACCELERATION_CONSTANT;
  }

  get linearDrag() {
    /*
    Drag = DragCoefficient * (.5 * airDensity) * velocity squared * Area of which the drag coefficient is based.
    */
    const x = this.dragCoefficient * // Drag coefficient
      .5 * this.airDensity * // 1/2 Air density
      Math.pow(this.velocity[0], 2) * // Velocity squared
      (this.gameObject.transform.scale.z * this.gameObject.transform.scale.y); // Area of reference point.

    const y = this.dragCoefficient * // Drag coefficient
      .5 * this.airDensity * // 1/2 Air density
      Math.pow(this.velocity[1], 2) * // Velocity squared
      (this.gameObject.transform.scale.x * this.gameObject.transform.scale.z); // Area of reference point.

    const z = this.dragCoefficient * // Drag coefficient
      .5 * this.airDensity * // 1/2 Air density
      Math.pow(this.velocity[2], 2) * // Velocity squared
      (this.gameObject.transform.scale.x * this.gameObject.transform.scale.y); // Area of reference point.

    return [x, y, z];
  }

  updateGravity() {
    /*
    Force = mass * acceleration
    Linear Acceleration = Force / Mass
    However, when drag = weight (gravitational force), acceleration = 0 (terminal velocity).
    Gravitational acceleration is therefore (weight - drag) / mass
    */
    const linearAcceleration = (this.weight - this.linearDrag[1]) / this.mass;
    this.velocity[1] -= linearAcceleration * Time.deltaTime;
    this.gameObject.transform.position.y += this.velocity[1] * Time.deltaTime; // Scale by framerate

  }

}

module.exports = RigidBody;
