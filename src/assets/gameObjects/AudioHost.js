const AudioPlayer = require("../../engine/AudioPlayer");
const GameObject = require("../../engine/GameObject");

class AudioHost extends GameObject {
  constructor(name = "audio") {
    super(name);
    this.addBehavior(AudioPlayer);
  }
}

module.exports = AudioHost;
