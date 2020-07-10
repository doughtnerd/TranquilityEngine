const GameObject = require("../../engine/GameObject");
const CameraObject = require("../../engine/CameraObject");
const Controllers = require("../gameObjects/Controllers");
const AudioHost = require("../gameObjects/AudioHost");
const PlayerObject = require("../gameObjects/PlayerObject");
const MonsterBase = require("../gameObjects/MonsterBase");
const SpriteDefaultMaterial = require("../../engine/shaders/sprite/default/SpriteDefaultMaterial");

module.exports = {
  gameObjects: [
    {
      type: GameObject,
      attributes: {
        name: "Custom",
      },
      behaviors: {
        Transform: {
          attributes: {
            position: {
              x: 2,
              y: 0,
              z: 0,
            },
          },
        },
        RigidBody: {
          type: require("../../engine/RigidBody"),
        },
        SpriteRenderer: {
          type: require("../../engine/SpriteRenderer"),
          attributes: {
            sprite: require("../images/moderncraft.png"),
            color: [1, 1, 1, 1],
            material: new SpriteDefaultMaterial(),
          },
        },
        BoxCollider: {
          type: require("../../engine/BoxCollider"),
        },
      },
    },
    {
      type: CameraObject,
      behaviors: {
        Transform: {
          attributes: {
            position: {
              x: 0,
              y: 2,
              z: 0,
            },
          },
        },
      },
    },
    {
      type: Controllers,
    },
    {
      type: AudioHost,
      behaviors: {
        AudioPlayer: {
          attributes: {
            playOnStart: true,
            loop: true,
            // audioPath: require("../music/town.mp3")
          },
        },
      },
    },
    {
      type: PlayerObject,
      attributes: {
        name: "Chris",
        tags: ["Player"],
      },
      behaviors: {
        Damager: {
          attributes: {
            damageAmount: 1,
          },
        },
        Transform: {
          attributes: {
            position: {
              x: 0,
              y: 0,
              z: 0,
            },
          },
        },
        SpriteRenderer: {
          attributes: {
            sprite: require("../images/flower.jpg"),
            color: [1, 1, 1, 1],
            material: new SpriteDefaultMaterial(),
          },
        },
      },
    },
    {
      type: MonsterBase,
      attributes: {
        name: "Orc",
      },
      behaviors: {
        Damager: {
          attributes: {
            damageAmount: 1,
          },
        },
        Damageable: {
          attributes: {
            health: 2,
          },
        },
        DropItemOnDeath: {
          attributes: {
            item: {
              damage: 2,
              hitChance: 0.25,
            },
          },
        },
        Transform: {
          attributes: {
            position: {
              x: -1,
              y: 0,
              z: 0,
            },
            scale: {
              x: 1,
              y: 1,
              z: 1,
            },
          },
        },
        SpriteRenderer: {
          attributes: {
            sprite: require("../images/moderncraft.png"),
            color: [1, 1, 1, 1],
            material: new SpriteDefaultMaterial(),
          },
        },
      },
    },
  ],
};
