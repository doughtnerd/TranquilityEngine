import vert from "./sprite-default.vert";
import frag from "./sprite-default.frag";
import Material from "../Material";
export default class SpriteDefaultMaterial extends Material {
  shader = {
    vert,
    frag,
  };

  colors = { uMainColor: [] };

  textures = { uMainTex: null };

  attributes = [];
}
