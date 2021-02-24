# TranquilityEngine

## What is it?
A JavaScript based 2D/3D game engine based on the Unity Game Engine.

## Why is it?
I've taken a look at the JS based game engine landscape and of them, the only one I'm impressed with is PhaserJS. With PhaserJS, they've done a lot of work to make building a game as simple as possible for new & advanced users. Most of the other engines that exist are overly complicated or didn't have a huge focus on being a 'Game Engine'. So, with my experience working with game engines I decided to make a fusion of JS and Unity. Unity in my opinion is one of the most accessible production grade engines out there to date and that's what I hope this engine will be one day too. My hope is that once this engine is complete enough, JS developers will be able to Zen-out and build a game while learning some of the core APIs that power Unity. 
## Limitations
This project is in active development and as such, might not have every feature 100% complete. It is also currently limited to WebGL for rendering. Lastly, this documentation will change as new features become complete and may not always reflect the current state of the engine.

## Quick Demo
![Basic Demo](./demo/BasicDemo.gif)
To see a very basic example of the game engine operating run:
```shell
npm run start
```
## Current Features
Again, these might be subject to change throughout development but the features that currently exist are described below.

## 2D & 3D Camera
The Game Engine's camera is built to be usable for both 2D perspective & orthographic games as well as full 3D games. Here's an example of the 3D Camera at work with the flappy bird example:

![3D Camera Demo](./demo/3DCameraDemo.gif)


### Custom rendering 
Allows for custom shaders to be developed and used in the project through the use of material and shader files like so:

![Shader Usage](./demo/ShaderUsage.gif)

### GameObjects
Like unity, everything that exists in a game scene is a GameObject. Each GameObject can have a number of scripts attached to it called GameBehaviors.
The basic skeleton for a GameObject class is the following:

#### PlayerObject.js
```JavaScript
const GameObject = require("../../engine/GameObject");

class PlayerObject extends GameObject {
  constructor(name = "Player") {
    super(name);
    // ... Below is where you would attach GameBehaviors 
  }
}

module.exports = PlayerObject;
```

### GameBehavior Based Scripting
Just like Unity, this game engine uses Behaviors that attach to your GameObjects but instead of being called MonoBehaviours, these kinds of scripts are called GameBehaviors. 

GameBehaviors have lifecycle hooks that can be used to bring your script to life. A basic GameBehavior script might look like the following:

```JavaScript
const GameBehavior = require('../../engine/GameBehavior');
const Damageable = require('./Damageable');
const Time = require('../../engine/Time');

class DropItemOnDeath extends GameBehavior {

  item;

  awake() {
    this.gameObject.getBehavior(Damageable).eventEmitter.addListener('Died', this.dropItem.bind(this));
  }

  update() {
    this.gameObject.transform.rotation.x = Time.time * 200;
  }

  onDestroy() {
    this.gameObject.getBehavior(Damageable).eventEmitter.removeListener(this.dropItem.bind(this))
  }

  dropItem() {
    console.log(`${this.gameObject.name} Dropped: ${this.item}`);
  }
}

module.exports = DropItemOnDeath;
```

### Scene Serialization and Loading
Much like any game engine, you can divide your game up into scenes and load them using the SceneManager class.

```JavaScript
import SceneManager from "./engine/SceneManager";

SceneManager.scenes = [require("./assets/scenes/scene1.js")];

SceneManager.eventEmitter.on("sceneLoading", (data: { progress: any }) => {
  console.log("Scene Load Progress: ", data.progress);
});

SceneManager.loadScene(0);
```

Scene files themselves currently are js files with json objects that configure the objects your scene might have and any adjustments to default settings.

```Javascript
const cameraObj = {
  sceneId: 0,
  type: CameraObject,
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(0, 0, -10),
      },
    },
    Camera: {
      attributes: {
        fieldOfView: 90,
        targetDisplayIndex: 0,
        projection: "orthographic",
      },
    },
  },
};

const playerObj = {
  sceneId: 1,
  type: PlayerObject,
  attributes: {
    name: "Player",
    tags: ["Player"],
  },
  behaviors: {
    Transform: {
      attributes: {
        position: new Vector3(-2, 2, 0),
        scale: new Vector3(2, 2, 1),
      },
    },
  },
};

module.exports = {
  gameObjects: [cameraObj, playerObj],
};
```


<!-- 
#### sprite-default.frag
```glsl
varying highp vec2 vTextureCoord;

uniform sampler2D uMainTex;
uniform lowp vec4 uMainColor;

void main() {
    gl_FragColor = texture2D(uMainTex, vTextureCoord);
    gl_FragColor.a *= uMainColor.a;
    gl_FragColor.rgb *= gl_FragColor.a;
}
```

#### sprite-default.vert
```glsl
attribute vec4 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat4 uModelViewProjectionMatrix;

varying highp vec2 vTextureCoord;

void main() {
  vTextureCoord = aTextureCoord;
  gl_Position = uModelViewProjectionMatrix * aVertexPosition;
}
```

#### SpriteDefaultMaterial.js
```JavaScript
const Material = require('../Material');
class SpriteDefaultMaterial extends Material {

  shader = {
    vert: require('./sprite-default.vert'),
    frag: require('./sprite-default.frag'),
  }

  colors = { uMainColor: [] };

  textures = { uMainTex: null };

  attributes = [];

}

module.exports = SpriteDefaultMaterial;
``` -->

### Custom RigidBody Physics & Collisions

The engine currently features a limited set of RigidBody physics and collisions. 
Current functionality includes:

- Impulse, normal, and gravity forces on rigidbodies.
- Sweep & Prune based collision detection.
- Box Collider for collision Detection.