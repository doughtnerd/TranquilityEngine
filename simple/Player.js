class Player {
  health = 10;
  inventory = {
    gold: 10,
    potions: [2, 2, 3, 4],
    weapon: { damage: 1, hitChance: 1 }
  }

  attack(monster) {
    monster.health -= this.inventory.weapon.damage;
    if (monster.health <= 0) {
      console.log('Monster died');
      monster = null;
    }
  }

  walk() {
    monster = new monsterTypes[0];
  }

  usePotion() {
    const potion = this.inventory.potions.shift();
    if (potion) {
      this.health += potion;
    }
  }
}

module.exports = Player;
