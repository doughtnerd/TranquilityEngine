const GameBehavior = require('../../engine/GameBehavior');

const PlayerObject = require('../gameObjects/PlayerObject');
const SceneManager = require('../../engine/SceneManager');
const Damageable = require('./Damageable');

class GameController extends GameBehavior {

  monster;
  player;

  startGame() {
    const name = readlineSync.question('What is your name? ');
  }

  awake() {
    this.player = SceneManager.activeScene.findObjectOfType(PlayerObject);
  }

  update() {
    if (this.player) {
      const damage = this.player.getBehavior(Damageable);
      if (damage.health <= 0) {
        console.log('You have died!');
      }
    }
  }
}

module.exports = GameController;
