# TranquilityEngine

## What is it?
A JavaScript based 2D/3D game engine based on the Unity Game Engine.

## Why is it?
I've taken a look at the JS based game engine landscape and of them, the only one I'm impressed with is PhaserJS. With PhaserJS, they've done a lot of work to make building a game as simple as possible for new & advanced users. Most of the other engines that exist are overly complicated or didn't have a huge focus on being a 'Game Engine'. So, with my experience working with game engines I decided to make a fusion of JS and Unity. Unity in my opinion is one of the most accessible production grade engines out there to date and that's what I hope this engine will be one day too. My hope is that once this engine is complete enough, JS developers will be able to Zen-out and build a game while learning some of the core APIs that power Unity. 
## Limitations
This project is in active development and as such, might not have every feature 100% complete. It is also currently limited to WebGL for rendering. Lastly, this documentation will change as new features become complete and may not always reflect the current state of the engine.

The engine is being rebuilt around three.js, Rapier physics, a hidden ECS core and Tauri. See the [design docs](docs/README.md) for the architecture and decision records, and [implementation status](docs/architecture/implementation-status.md) for what exists today. Sections below the demo describe the original 2021 prototype and are out of date.

## Quick Demo
![Basic Demo](./demo/BasicDemo.gif)
The v1 demo is a Flappy Bird clone, shipped as a sample project in `samples/flappy/` (samples come with the engine but aren't built into it). To play it, start the editor, open the Flappy Bird sample from the start screen and press **Play** (space, up arrow or click to flap):
```shell
npm install
npm run dev
```
The editor is at http://localhost:3000/editor.html (`/` goes there). Run the engine tests with `npm test`, the browser smoke tests with `npm run test:e2e` (run `npm run test:e2e:install` first), and typecheck with `npm run typecheck`. `npm run build` writes the editor, with the samples beside it, to `dist/editor/` and the engine library to `dist/engine/`.

In a browser the editor opens samples read-only. Run `npm run tauri:dev` for the desktop editor, where **Open Project…** opens a project folder (one with a `project.json`), **Make a Copy…** copies a sample into a folder to edit it, and **Save** / Ctrl+S writes scenes back to disk. Desktop builds need [Tauri](https://v2.tauri.app/): install Rust ([rustup](https://rustup.rs/)) first. `npm run tauri:build` produces installers.

An Engine can run several Worlds at once, for example a client and a server, and multiplayer is built on that: server-authoritative, with replication, inputs and client prediction. The [Worlds guide](docs/guide/worlds.md) and the [Multiplayer guide](docs/guide/multiplayer.md) explain how to set them up. `npm run server -- <projectDir>` runs a project's server Worlds headless in Node over WebSocket (`--help` lists the options).
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
import GameObject from "../../engine/GameObject";

export default class PlayerObject extends GameObject {
  constructor(name = "Player") {
    super(name);
    // Game Behaviors can be attached below
  }
}

```

### GameBehavior Based Scripting
Just like Unity, this game engine uses Behaviors that attach to your GameObjects but instead of being called MonoBehaviours, these kinds of scripts are called GameBehaviors. 

GameBehaviors have lifecycle hooks that can be used to bring your script to life. A basic GameBehavior script might look like the following:

```JavaScript
import GameBehavior from "../../engine/GameBehavior";
import Time from "../../engine/Time";
import Damageable from "./Damageable";

export default class DropItemOnDeath extends GameBehavior {
  item;

  awake() {
    this.gameObject.getBehavior(Damageable).eventEmitter.addListener("Died", this.dropItem.bind(this));
  }

  update() {
    // Do something every frame if you want
  }

  onDestroy() {
    this.gameObject.getBehavior(Damageable).eventEmitter.removeListener(this.dropItem.bind(this));
  }

  dropItem() {
    console.debug(`${this.gameObject.name} Dropped: ${this.item}`);
  }
}
```

### Scene Serialization and Loading
Much like any game engine, you can divide your game up into scenes and load them using the SceneManager class.

```JavaScript
import SceneManager from "./engine/SceneManager";
import scene1 from './assets/scenes/scene1.js'

SceneManager.scenes = [scene1];

SceneManager.eventEmitter.on("sceneLoading", (data: { progress: any }) => {
  console.debug("Scene Load Progress: ", data.progress);
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

### Custom RigidBody Physics & Collisions

The engine currently features a limited set of RigidBody physics and collisions. 
Current functionality includes:

- Impulse, normal, and gravity forces on rigidbodies.
- Sweep & Prune based collision detection.
- Box Collider for collision Detection.