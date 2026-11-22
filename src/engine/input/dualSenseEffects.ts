/**
 * DualSense adaptive trigger effects as the controller's own bytes, shared by the WebHID driver
 * (`webHid/dualSense.ts`, which sends them in its output reports) and the desktop adapter
 * (`tauriGamepads.ts`, which hands an effects block to SDL's `SDL_SendGamepadEffect`). The layout
 * is SDL's `DS5EffectsState_t` (`SDL_hidapi_ps5.c`, zlib licence, copyright (C) 1997-2025 Sam
 * Lantinga).
 */
import type { TriggerEffect } from "./triggerEffects";

/** The frequency trigger rumble vibrates at, and a vibration effect's default, Hz. */
export const TRIGGER_RUMBLE_HZ = 50;

/** The trigger block that frees a trigger. */
export const TRIGGER_OFF = Uint8Array.of(0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/** The length of the effects block (`DS5EffectsState_t`). */
export const EFFECTS_BLOCK_LENGTH = 47;

/** Where each trigger's 11-byte block sits in the effects block, and the enable bit (byte 0) that applies it. */
const TRIGGER_SLOT = { right: { offset: 10, enable: 0x04 }, left: { offset: 21, enable: 0x08 } } as const;

/** An adaptive trigger effect as the DualSense's 11-byte trigger block. */
export function encodeTriggerEffect(effect: TriggerEffect): Uint8Array {
  const out = new Uint8Array(11);
  const frac = (v: number | undefined, d: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? (v as number) : d));
  const zone = (v: number | undefined, d: number) => Math.round(frac(v, d) * 9);
  const level = (v: number | undefined) => Math.round(frac(v, 1) * 8); // 0 none, 1..8
  // Ten zones along the travel: a mask of active zones and a 3-bit value per zone.
  const zones = (start: number, value: number) => {
    let active = 0;
    let values = 0;
    for (let z = start; z < 10; z++) {
      active |= 1 << z;
      values += (value - 1) * 2 ** (3 * z);
    }
    out[1] = active & 0xff;
    out[2] = active >> 8;
    for (let i = 0; i < 4; i++) out[3 + i] = Math.floor(values / 2 ** (8 * i)) & 0xff;
  };
  switch (effect.mode) {
    case "resistance": {
      const strength = level(effect.strength);
      if (!strength) return TRIGGER_OFF;
      out[0] = 0x21;
      zones(zone(effect.start, 0), strength);
      return out;
    }
    case "weapon": {
      const strength = level(effect.strength);
      if (!strength) return TRIGGER_OFF;
      const start = Math.min(7, Math.max(2, zone(effect.start, 0.3)));
      const end = Math.min(8, Math.max(start + 1, zone(effect.end, 0.6)));
      const mask = (1 << start) | (1 << end);
      out[0] = 0x25;
      out[1] = mask & 0xff;
      out[2] = mask >> 8;
      out[3] = strength - 1;
      return out;
    }
    case "vibration": {
      const amplitude = level(effect.amplitude);
      if (!amplitude) return TRIGGER_OFF;
      out[0] = 0x26;
      zones(zone(effect.start, 0), amplitude);
      out[9] = Math.min(255, Math.max(1, Math.round(effect.frequency ?? TRIGGER_RUMBLE_HZ)));
      return out;
    }
    default:
      return TRIGGER_OFF;
  }
}

/**
 * An effects block that sets one trigger's effect and changes nothing else: only that trigger's
 * enable bit is set, so the motors, lights and the other trigger keep what they have.
 */
export function triggerEffectBlock(trigger: "left" | "right", effect: TriggerEffect): Uint8Array {
  const block = new Uint8Array(EFFECTS_BLOCK_LENGTH);
  const slot = TRIGGER_SLOT[trigger];
  block[0] = slot.enable;
  block.set(encodeTriggerEffect(effect), slot.offset);
  return block;
}
