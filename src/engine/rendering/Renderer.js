import GameBehavior from "../GameBehavior";

export default class Renderer extends GameBehavior {
  material = {};
  materials = [];
  rendererPriority = 1000;
  renderingLayerMask;
  worldToLocalMatrix;

  getMaterials() {
    return this.materials;
  }

  render(camera) {}
}
