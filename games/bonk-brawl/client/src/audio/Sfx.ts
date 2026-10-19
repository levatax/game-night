// Every sound id in the game (game1.md §12) + how it should sound. Owner: client-audio
// (written by architect, complete). All synthesized procedurally with Web Audio (no files).

/** One-shot sound effects. */
export type SfxId =
  | "bounce"
  | "squeak"
  | "throw"
  | "throwHeavy"
  | "bonk"
  | "ding"
  | "catch"
  | "crowdOoh"
  | "whiff"
  | "slideWhistle"
  | "pickup"
  | "ballDrop"
  | "jump"
  | "land"
  | "roll"
  | "flapDash"
  | "groundPoundLeap"
  | "shockwave"
  | "bellyBoing"
  | "curveArm"
  | "bellySlide"
  | "headbutt"
  | "boomerang"
  | "honk"
  | "ko"
  | "powerUpWarning"
  | "powerUpSparkle"
  | "powerUpPickup"
  | "zoomies"
  | "ringShake"
  | "crumbleRumble"
  | "countdownTick"
  | "countdownGo"
  | "suddenDeath"
  | "uiClick"
  | "uiHover"
  | "uiToggle"
  | "uiError";

/** Continuous sounds controlled through a LoopHandle. */
export type LoopId =
  /** Charge whoosh rising in pitch with charge (param 0..1), shimmering at full. */
  | "charge"
  /** Pip's belly slide scrape (param = speed 0..1). */
  | "slide"
  /** Zoomies sneaker patter (param = speed 0..1). */
  | "zoomies";

/** Character voice moments (quack, ribbit, grumble, meow, squawk, bleat per CharacterDef.voice). */
export type VoiceKind = "hit" | "throw" | "emote" | "ko" | "win" | "catch";

export type SfxBus = "sfx" | "ui";

export interface SfxDef {
  bus: SfxBus;
  /** Played through a PannerNode at the event position when a pos is given. */
  positional: boolean;
  /** Base gain 0..1 before bus volumes. */
  volume: number;
  /** Synthesis brief for the client-audio author. */
  sound: string;
}

export const SFX: Readonly<Record<SfxId, SfxDef>> = {
  bounce: { bus: "sfx", positional: true, volume: 0.5, sound: "rubbery boing, pitch/volume scale with impact speed" },
  squeak: { bus: "sfx", positional: true, volume: 0.4, sound: "short rubber-ball squeak (hard bounces, pickups)" },
  throw: { bus: "sfx", positional: true, volume: 0.6, sound: "airy 'fwip' (filtered noise sweep down)" },
  throwHeavy: { bus: "sfx", positional: true, volume: 0.75, sound: "bigger 'FWOOMP' for full charge / mega" },
  bonk: { bus: "sfx", positional: true, volume: 0.9, sound: "cartoon BONK: wood-block knock + pitch-drop boing" },
  ding: { bus: "sfx", positional: false, volume: 0.6, sound: "bright satisfying 'ding' for the thrower on a hit (not positional)" },
  catch: { bus: "sfx", positional: true, volume: 0.9, sound: "meaty 'thwap' (low thump + slap noise)" },
  crowdOoh: { bus: "sfx", positional: false, volume: 0.5, sound: "crowd 'OOOH' (stacked detuned formant voices, swelling)" },
  whiff: { bus: "sfx", positional: true, volume: 0.5, sound: "flailing whoosh + sad 'wah' slide" },
  slideWhistle: { bus: "sfx", positional: true, volume: 0.8, sound: "slide whistle down ~1.2 s (ring-out)" },
  pickup: { bus: "sfx", positional: true, volume: 0.45, sound: "quick 'bloop' pop" },
  ballDrop: { bus: "sfx", positional: true, volume: 0.4, sound: "falling whistle as a ball drops from the sky" },
  jump: { bus: "sfx", positional: true, volume: 0.35, sound: "springy 'boing' up-pitch, short" },
  land: { bus: "sfx", positional: true, volume: 0.35, sound: "soft 'pomf' thud, volume by land speed" },
  roll: { bus: "sfx", positional: true, volume: 0.45, sound: "tumbling whoosh 'whirr'" },
  flapDash: { bus: "sfx", positional: true, volume: 0.6, sound: "wing flaps burst + whoosh" },
  groundPoundLeap: { bus: "sfx", positional: true, volume: 0.55, sound: "rising 'hup!' boing" },
  shockwave: { bus: "sfx", positional: true, volume: 0.9, sound: "heavy ground thump + rumble boom" },
  bellyBoing: { bus: "sfx", positional: true, volume: 0.8, sound: "huge jelly 'BWOING' (ball deflected off Mochi)" },
  curveArm: { bus: "sfx", positional: true, volume: 0.5, sound: "mischievous swirl sparkle" },
  bellySlide: { bus: "sfx", positional: true, volume: 0.55, sound: "'wheee' start + slide whoosh" },
  headbutt: { bus: "sfx", positional: true, volume: 0.85, sound: "hollow 'CLONK' + goat bell jingle" },
  boomerang: { bus: "sfx", positional: true, volume: 0.5, sound: "wobbling 'whum-whum' turn-around" },
  honk: { bus: "sfx", positional: true, volume: 0.7, sound: "bike-horn honk (emote)" },
  ko: { bus: "sfx", positional: true, volume: 0.8, sound: "pop + feather/fur poof" },
  powerUpWarning: { bus: "sfx", positional: true, volume: 0.4, sound: "rising shimmer chime (2 s warning)" },
  powerUpSparkle: { bus: "sfx", positional: true, volume: 0.55, sound: "magical sparkle arpeggio (power-up appears)" },
  powerUpPickup: { bus: "sfx", positional: true, volume: 0.7, sound: "level-up 'ba-ding!' arpeggio" },
  zoomies: { bus: "sfx", positional: true, volume: 0.6, sound: "cartoon 'zoom' revving up" },
  ringShake: { bus: "sfx", positional: true, volume: 0.6, sound: "creaky crack + low rattle" },
  crumbleRumble: { bus: "sfx", positional: true, volume: 0.85, sound: "rumble + crumbling debris (sudden-death ring drop)" },
  countdownTick: { bus: "ui", positional: false, volume: 0.6, sound: "woodblock tick (3, 2, 1)" },
  countdownGo: { bus: "ui", positional: false, volume: 0.8, sound: "big 'BONK!' gong-honk for GO" },
  suddenDeath: { bus: "ui", positional: false, volume: 0.8, sound: "goofy alarm siren (kazoo-ish)" },
  uiClick: { bus: "ui", positional: false, volume: 0.4, sound: "soft bubble click" },
  uiHover: { bus: "ui", positional: false, volume: 0.15, sound: "tiny tick" },
  uiToggle: { bus: "ui", positional: false, volume: 0.35, sound: "two-tone toggle blip" },
  uiError: { bus: "ui", positional: false, volume: 0.4, sound: "low 'bwomp' buzz" },
};

export const SFX_IDS = Object.keys(SFX) as SfxId[];
