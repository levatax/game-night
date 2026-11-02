// Performance script for Cemil Abi's ElevenLabs lines.
//
// The text in games/kasala/shared/announcer.ts is the subtitle text: clean, no markup. This module adds the
// v4 audio tags and pauses that only the voice renderer sees, so the announcer sounds like a person running a
// back-room table instead of a narrator reading a list.
//
//   import { performanceText } from "./voice-performance";
//   performanceText({ id, text })  // → "[shouting] POLİS! ..."
//
// Tags are ElevenLabs v4 audio tags; the model ignores an unknown one rather than failing.

import type { AnnouncerLine } from "../games/kasala/shared/announcer";

/** Lines whose delivery is hand-written (the rest get the tag for their event family). */
const OVERRIDES: Readonly<Record<string, string>> = {
  baskin_01: "[shouting] POLİS! Herkes yere! [pause] [sarcastic] ...Sen hariç. [laughs] Sen kelepçeye.",
};

/**
 * Event-family delivery: the first matching prefix wins. Longest/most specific prefixes come first so
 * `baskin_ilk_kart` keeps its own reading instead of falling into `baskin`.
 */
const TAGS: readonly (readonly [prefix: string, tag: string])[] = [
  ["baskin_ilk_kart", "[laughs]"],
  ["baskin", "[shouting]"],
  ["cark_kumbara", "[shouting]"],
  ["cark_toplu_baskin", "[shouting]"],
  ["cark_bir_daha", "[shouting]"],
  ["cark_x10", "[shouting]"],
  ["cark_karistir", "[shouting]"],
  ["cark_iniyor", "[excited]"],
  ["cark_herkese", "[laughs]"],
  ["cark_avukat", "[sarcastic]"],
  ["kasala_buyuk", "[shouting]"],
  ["kasala_kucuk", "[laughs]"],
  ["para_buyuk", "[excited]"],
  ["para_kucuk", "[sarcastic]"],
  ["siren_kritik", "[shouting]"],
  ["siren_orta", "[nervous]"],
  ["sure_azaldi", "[shouting]"],
  ["bahis_acildi", "[excited]"],
  ["bahis_kapandi", "[whispers]"],
  ["bahis_sonuc", "[sarcastic]"],
  ["bahis", "[sarcastic]"],
  ["harac_turu", "[sarcastic]"],
  ["harac", "[sarcastic]"],
  ["avukat_kurtardi", "[excited]"],
  ["avukat", "[sarcastic]"],
  ["borc_reddedildi", "[sighs]"],
  ["borc_odendi", "[sighs]"],
  ["borc_verildi", "[sarcastic]"],
  ["borc", "[sarcastic]"],
  ["lanet_tuttu", "[laughs]"],
  ["lanet", "[whispers]"],
  ["mezardan_dondu", "[laughs]"],
  ["nehre_atildi", "[sad]"],
  ["mac_basi", "[clears throat]"],
  ["mac_sonu", "[sighs]"],
  ["tur_basi", "[sarcastic]"],
  ["son_sans", "[nervous]"],
  ["son_masa", "[shouting]"],
  ["takas", "[shouting]"],
  ["tuzak", "[sarcastic]"],
  ["rusvet", "[whispers]"],
  ["taslik", "[sarcastic]"],
  ["unvan", "[laughs]"],
  ["carpan", "[excited]"],
];

/** The line as the voice should read it: audio tags plus the subtitle text. */
export function performanceText(line: Pick<AnnouncerLine, "id" | "text">): string {
  const override = OVERRIDES[line.id];
  if (override) return override;
  const match = TAGS.find(([prefix]) => line.id.startsWith(prefix));
  return match ? `${match[1]} ${line.text}` : line.text;
}
