const GameBehavior = require("./GameBehavior");
const Time = require("./Time");
const Physics = require("./Physics");
const { Vector3 } = require("./Vector3");

class RigidBody extends GameBehavior {
  useGravity = false;
  static = false;
  mass = 20;
  dragCoefficient = 0.01;
  angularDrag = 0.05;

  airDensity = 2;
  velocity = Vector3.zero;
  angularVelocity = [0, 0, 0];
  maxLinearVelocity;
  maxAngularVelocity;

  inertiaTensor;

  acceleration = Vector3.zero;

  awake() {
    this.inertiaTensor = Physics.computeCuboidInertiaTensorMatrix(
      this.mass,
      this.gameObject.transform.scale.x,
      this.gameObject.transform.scale.y,
      this.gameObject.transform.scale.z
    );
  }

  fixedUpdate() {
    if(this.static) {
      return;
    }

    if (this.useGravity) {
      this.acceleration = Vector3.add(this.acceleration, Vector3.scale(this.calculateGravityAcceleration(), Time.fixedDeltaTime))
    }
    
    this.acceleration = Vector3.scale(this.acceleration, Time.fixedDeltaTime);
    this.velocity = Vector3.add(this.velocity, this.acceleration);
    // this.velocity = Vector3.scale(this.velocity, Time.fixedDeltaTime);

    let newGameObjectPosition = Vector3.add(
      this.gameObject.transform.position,
      this.velocity
    );

    this.gameObject.transform.position = newGameObjectPosition;

    this.acceleration = Vector3.zero;
  }

  addForce(forceVector, mode = 'force') {

    switch(mode) {
      case 'force':
        forceVector = Vector3.scale(forceVector, Time.fixedDeltaTime)
        forceVector = Vector3.divideScalar(forceVector, this.mass);
        this.acceleration = Vector3.add(this.acceleration, forceVector);
        break;
      case 'impulse':
        forceVector = Vector3.divideScalar(forceVector, this.mass);
        this.acceleration = Vector3.add(this.acceleration, forceVector);
        break;
    }
    
  }

  addTorque(torqueVector) {
    const angularAcceleration = [
      torqueVector[0] / this.inertiaTensor[0][0],
      torqueVector[1] / this.inertiaTensor[1][1],
      torqueVector[2] / this.inertiaTensor[2][2],
    ];
    this.angularVelocity[0] += angularAcceleration[0];
    this.angularVelocity[1] += angularAcceleration[1];
    this.angularVelocity[2] += angularAcceleration[2];
    this.gameObject.transform.rotation.x +=
      this.angularVelocity[0] * Time.fixedDeltaTime;
    this.gameObject.transform.rotation.y +=
      this.angularVelocity[1] * Time.fixedDeltaTime;
    this.gameObject.transform.rotation.z +=
      this.angularVelocity[2] * Time.fixedDeltaTime;
  }

  get weight() {
    /*
      Weight (gravitational force) is a function of mass * the gravitational force given off by an object.
      For earth, a constant of 9.8 is used even though gravity varies the farther/closer from/to an object you get.
    */
    return this.mass * Physics.GRAVITATIONAL_ACCELERATION_CONSTANT;
  }

  get linearDrag() {
    /*
    Drag = DragCoefficient * (.5 * airDensity) * velocity squared * Area of which the drag coefficient is based.
    */
    const x =
      this.dragCoefficient * // Drag coefficient
      (0.5 * this.airDensity) * // 1/2 Air density
      Math.pow(this.velocity.x, 2) *
      (this.velocity.x < 0 ? -1 : 1) * // Velocity squared
      (this.gameObject.transform.scale.z * this.gameObject.transform.scale.y); // Area of reference point.

    const y =
      this.dragCoefficient * // Drag coefficient
      (0.5 * this.airDensity) * // 1/2 Air density
      Math.pow(this.velocity.y, 2) *
      // (this.velocity.y < 0 ? -1 : 1) * // Velocity squared
      (this.gameObject.transform.scale.x * this.gameObject.transform.scale.z); // Area of reference point.

    const z =
      this.dragCoefficient * // Drag coefficient
      (0.5 * this.airDensity) * // 1/2 Air density
      Math.pow(this.velocity.z, 2) *
      (this.velocity.z < 0 ? -1 : 1) * // Velocity squared
      (this.gameObject.transform.scale.x * this.gameObject.transform.scale.y); // Area of reference point.

    // return [x, y, z];
    return new Vector3(x, y, z);
  }

  calculateGravityAcceleration() {
    /*
    Force = mass * acceleration
    Linear Acceleration = Force / Mass
    However, when drag = weight (gravitational force), acceleration = 0 (terminal velocity).
    Gravitational acceleration is therefore (weight - drag) / mass
    */
    const linearAcceleration = (this.weight - this.linearDrag.y) / this.mass;
    return new Vector3(0, -linearAcceleration, 0);
  }
}

module.exports = RigidBody;
