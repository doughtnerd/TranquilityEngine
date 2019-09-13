const GameBehavior = require('../../engine/GameBehavior');
const EventEmitter = require('events');
const readlineSync = require('readline-sync');

class PlayerInput extends GameBehavior {

  availableActions = [''];
  eventEmitter = new EventEmitter();

  getPlayerInput() {
    const action = readlineSync.question("What would you like to do (type 'list actions' to list available actions)? ");

    if (action === 'list actions') {
      console.log(this.availableActions);
    }

    this.eventEmitter.emit('PlayerInput', action);

    return action;
  }
}

module.exports = PlayerInput;
