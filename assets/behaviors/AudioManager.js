const GameBehavior = require('../../engine/GameBehavior');
const AudioPlayer = require('../../engine/AudioPlayer');

class AudioManager extends GameBehavior {

  start() {
    this.gameObject.getBehavior(AudioPlayer).loop('./assets/music/town.mp3');
  }
}

module.exports = AudioManager;
