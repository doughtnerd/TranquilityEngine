
class Endpoint {

  collider;
  value;
  isMin;

  constructor(collider, value, isMin) {
    this.collider = collider;
    this.value = value;
    this.isMin = isMin;
  }
}

module.exports = Endpoint;
