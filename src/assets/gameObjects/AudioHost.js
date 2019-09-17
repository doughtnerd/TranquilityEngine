const AudioPlayer = require('../../engine/AudioPlayer');
const AudioManager = require('../behaviors/AudioManager');
const GameObject = require('../../engine/GameObject');

class AudioHost extends GameObject {

  constructor(name = 'audio') {
    super(name);
    this.addBehavior(AudioPlayer);
  }
}

module.exports = AudioHost;
