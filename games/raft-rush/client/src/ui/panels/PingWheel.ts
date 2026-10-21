// Ping wheel (§12: V or middle click): "Over here!", "Help!", "Need this" (the app attaches what you were looking
// at), "Danger!". Emits `marker`; the server broadcasts it (compass mark 8 s + a 3D balloon). Owner: client-ui.

import { MARKER_KINDS } from "../../../../shared/constants";
import type { MarkerKind } from "../../../../shared/types";
import { t } from "../../i18n";
import { MARKER_COLOR, MARKER_ICON } from "../content";
import { RadialMenu } from "./RadialMenu";

export class PingWheel extends RadialMenu<MarkerKind> {
  constructor(onPick: (kind: MarkerKind) => void, onClose: () => void) {
    super(
      "rr-radial--ping",
      `📡 ${t("panels.pingTitle")}`,
      "panels.pingHint",
      MARKER_KINDS.map((id) => ({ id, icon: MARKER_ICON[id], label: t(`panels.ping_${id}`), color: MARKER_COLOR[id] })),
      onPick,
      onClose,
    );
  }
}
