const GameBehavior = require("../GameBehavior");
const eventEmitter = require('events');

class Renderer extends GameBehavior {
    material = {};
    materials = [];
    rendererPriority = 1000;
    renderingLayerMask;
    worldToLocalMatrix;

    getMaterials() {
        return this.materials;
    }
}

module.exports = Renderer;