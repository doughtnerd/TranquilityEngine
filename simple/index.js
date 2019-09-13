const readlineSync = require('readline-sync');
const Player = require('./Player');
const { BaseMonster, Goblin } = require('./monsters');

const player = new Player();
const monsterTypes = [Goblin, BaseMonster];
let monster = null;

const action = readlineSync.question('What would you like to do? ');

switch (action) {
  case 'fight': {

  }
}

process.on('SIGINT', () => {
  const answer = readlineSync.question('Would you like to quit? [y/n]');

  if (['y', 'Y', 'yes', 'Yes'].includes(answer)) {
    process.exit(1);
  }
});
