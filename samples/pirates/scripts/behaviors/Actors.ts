import { GameBehavior, behavior } from "myco";

/** Marks the scene node ships and cannonballs spawn under (the server waits for it). */
@behavior("pirates.Actors", { worlds: ["client", "server"] })
export class Actors extends GameBehavior {}
