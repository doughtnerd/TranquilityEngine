class BaseMonster {
  health = 1;
  gold = 5;
  weapon = { damage: 1, hitChance: .5 }

  attack(player) {
    player.health -= this.weapon.damage;
    if (player.health <= 0) {
      console.log('player died!')
    }
  }
}

class Goblin extends BaseMonster {
  health = 2;
  gold = 10;
}

module.exports = {
  Goblin,
  BaseMonster
};
