// Sound names. Owner: client-audio (written by the architect, complete; add names only by appending).
// Every sound is synthesized with Web Audio (no files), §18.

export const SFX_NAMES = [
  // ui
  "uiClick",
  "uiHover",
  "uiOpen",
  "uiClose",
  "uiError",
  "uiTick",
  // gathering & items
  "chop",
  "chopDone",
  "mine",
  "mineDone",
  "rustle",
  "berry",
  "pickup",
  "drop",
  "coconutFall",
  "palmShake",
  "craft",
  "hammer",
  "place",
  "chestOpen",
  "chestClose",
  "eat",
  "drink",
  "burp",
  "spring",
  // throwing
  "chargeStart",
  "throw",
  "throwHeavy",
  "toss",
  "catch",
  "bonk",
  "hit",
  "bootBonk",
  "splash",
  "stick",
  "bounce",
  "swing",
  // fire & raft
  "fireFeed",
  "fireLow",
  "fireOut",
  "deliver",
  "raftStage",
  "raftReady",
  "raftGnaw",
  "board",
  "launch",
  "fenceBreak",
  // monsters
  "crabEmerge",
  "crabClick",
  "crabBite",
  "crabFlip",
  "crabDie",
  "pufferPop",
  "bossRoar",
  "bossStomp",
  "monkey",
  "gull",
  "steal",
  "kraken",
  // player state
  "jump",
  "land",
  "footstep",
  "swimStroke",
  "waterIn",
  "waterOut",
  "hurt",
  "downed",
  "revive",
  "washed",
  "respawn",
  "lowBar",
  "shiver",
  "blast",
  "jellyZap",
  "fuseTick",
  // fishing & luck
  "cast",
  "bite",
  "reelSpin",
  "reelTick",
  "reelStop",
  "catchFish",
  "miss",
  "treasure",
  "golden",
  "bottle",
  "legendary",
  // flow & social
  "marker",
  "emote",
  "dayStart",
  "duskDrums",
  "nightStart",
  "stormWarn",
  "thunder",
  "win",
  "lose",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

/** Continuous sounds, started / updated with AudioEngine.loop(key, name, …) and stopped with stopLoop(key). */
export const LOOP_NAMES = ["charge", "fire", "rain", "waves", "crickets", "gulls", "wind", "drums", "swim", "fuse", "reel", "storm", "channel"] as const;
export type LoopName = (typeof LOOP_NAMES)[number];

/** Per-tourist formant gibberish (Jelly voices.ts style). */
export type VoiceKind = "hurt" | "throw" | "eat" | "panic" | "laugh" | "help" | "yes" | "cheer" | "emote" | "downed" | "revived" | "shiver";

/** Music state (Bonk Band engine: ukulele / kazoo / xylophone; night = minor mode; boss + storm intensify). */
export type MusicMood = "off" | "lobby" | "day" | "dusk" | "night" | "boss" | "storm" | "launch" | "win" | "lose";
