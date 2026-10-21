// Emote wheel (§12: T + 1–6): clap, panic, dance, tired, shush, selfie (the Influencer's special). Emits `emote`.
// Owner: client-ui.

import { EMOTE_IDS } from "../../../../shared/constants";
import type { EmoteId } from "../../../../shared/types";
import { t } from "../../i18n";
import { emoteIcon } from "../content";
import { RadialMenu } from "./RadialMenu";

const EMOTE_COLOR: Record<EmoteId, string> = {
  clap: "#FFD166",
  panic: "#FF5A5F",
  dance: "#A86CF0",
  tired: "#8ED1FC",
  shush: "#7CCB6B",
  selfie: "#FF6FB5",
};

export class EmoteWheel extends RadialMenu<EmoteId> {
  constructor(onPick: (emote: EmoteId) => void, onClose: () => void) {
    super(
      "rr-radial--emote",
      `🎭 ${t("panels.emoteTitle")}`,
      "panels.emoteHint",
      EMOTE_IDS.map((id) => ({
        id,
        icon: emoteIcon(id),
        label: t(`panels.emote_${id}`),
        color: EMOTE_COLOR[id],
        tag: id === "selfie" ? t("panels.selfieTag") : undefined,
      })),
      onPick,
      onClose,
    );
  }
}
