// Top-right raft card (§7, §17): three segments (hull / mast & sail / supplies) that fill as parts are delivered,
// the current stage's part counts ("🪵 7/16", "🪵 2/4 · 🧵 3/6", "🍗 1/4 · 💧 0/4"), READY! once all three are
// done ("READY! Press E on it", the player's interact key) and "3/5 aboard" while boarding. Gnawing that drops a
// stage back simply shows up as the bars receding (with a red shake). Owner: client-ui.

import type { RaftStage } from "../../../../shared/types";
import { t } from "../../i18n";
import { itemIcon } from "../content";
import { keyParams, keysSignature } from "../controls";
import { clamp01, el, replay, setHidden, setText, setVar, svg, toggleClass } from "../dom";
import { ICON_CHECK, ICON_RAFT } from "../icons";
import type { HudModel, RaftPartModel } from "../models";

const STAGE_PARTS: ReadonlyArray<ReadonlyArray<RaftPartModel["part"]>> = [["hullWood"], ["mastWood", "mastRope"], ["food", "water"]];

const PART_ICON: Record<RaftPartModel["part"], string> = {
  hullWood: itemIcon("wood"),
  mastWood: itemIcon("wood"),
  mastRope: itemIcon("rope"),
  food: "🍗",
  water: itemIcon("water"),
};

interface SegView {
  root: HTMLElement;
  fill: HTMLElement;
  frac: number;
}

export class RaftProgress {
  readonly el = el("div", "rr-raft");
  private readonly stageLabel = el("span", "rr-raft__stage");
  private readonly segs: SegView[] = [];
  private readonly parts = el("div", "rr-raft__parts");
  private readonly ready = el("div", "rr-raft__ready");
  private readonly readyText = el("span");
  private readonly aboard = el("div", "rr-raft__aboard");
  private stage: RaftStage | -1 = -1;
  private partsSig = "";
  private readySig = "";
  private total = -1;

  constructor() {
    const head = el("div", "rr-raft__head", el("span", "rr-raft__icon", svg(ICON_RAFT)), el("span", "rr-raft__title", t("hud.raftTitle")), this.stageLabel);
    const row = el("div", "rr-raft__segs");
    for (let i = 0; i < 3; i++) {
      const fill = el("span", "rr-raft__fill");
      const root = el("div", "rr-raft__seg", el("span", "rr-raft__seg-track", fill), el("span", "rr-raft__seg-label", t(`hud.raftStage_${i}`)), el("span", "rr-raft__seg-done", svg(ICON_CHECK)));
      this.segs.push({ root, fill, frac: -1 });
      row.append(root);
    }
    this.ready.append(this.readyText);
    this.ready.hidden = true;
    this.aboard.hidden = true;
    this.el.append(head, row, this.parts, this.ready, this.aboard);
  }

  update(raft: HudModel["raft"]): void {
    const byPart = new Map(raft.parts.map((p) => [p.part, p] as const));
    let total = 0;
    STAGE_PARTS.forEach((ids, i) => {
      let have = 0;
      let need = 0;
      for (const id of ids) {
        const p = byPart.get(id);
        if (!p) continue;
        have += Math.min(p.have, p.need);
        need += p.need;
      }
      const frac = raft.stage > i ? 1 : raft.stage < i ? 0 : need > 0 ? clamp01(have / need) : 0;
      total += frac;
      this.renderSeg(this.segs[i]!, frac, raft.stage, i);
    });

    if (raft.stage !== this.stage) {
      const back = this.stage !== -1 && raft.stage < this.stage;
      const forward = this.stage !== -1 && raft.stage > this.stage;
      this.stage = raft.stage;
      this.el.dataset.stage = String(raft.stage);
      setText(this.stageLabel, raft.stage < 3 ? `${raft.stage + 1}/3` : "");
      if (back) replay(this.el, "is-hurt");
      if (forward) replay(this.el, "is-stage-up");
    }
    // Gnawed wood: the total shrank without a stage change.
    if (this.total >= 0 && total < this.total - 1e-6 && raft.stage === this.stage) replay(this.el, "is-hurt");
    this.total = total;

    this.renderParts(raft.stage, byPart);
    // The ready line names the interact key: re-print it when the preset / layout changed (Esc menu mid-match).
    const readySig = raft.ready ? `1|${raft.aboard}|${raft.total}|${keysSignature()}` : "0";
    if (readySig !== this.readySig) {
      this.readySig = readySig;
      if (raft.ready) setText(this.readyText, t("hud.raftReady", keyParams()));
      setHidden(this.ready, !raft.ready);
      toggleClass(this.el, "is-ready", raft.ready);
      const boarding = raft.ready && raft.aboard > 0;
      setHidden(this.aboard, !boarding);
      if (boarding) setText(this.aboard, `⛵ ${t("hud.raftAboard", { n: raft.aboard, total: raft.total })}`);
    }
  }

  private renderSeg(v: SegView, frac: number, stage: RaftStage, index: number): void {
    toggleClass(v.root, "is-current", stage === index);
    toggleClass(v.root, "is-done", stage > index);
    if (Math.abs(frac - v.frac) < 0.002) return;
    v.frac = frac;
    setVar(v.fill, "--v", `${(frac * 100).toFixed(1)}%`);
  }

  private renderParts(stage: RaftStage, byPart: Map<RaftPartModel["part"], RaftPartModel>): void {
    const ids = stage < 3 ? STAGE_PARTS[stage]! : [];
    const sig = ids.map((id) => `${id}:${byPart.get(id)?.have ?? 0}/${byPart.get(id)?.need ?? 0}`).join("|");
    if (sig === this.partsSig) return;
    this.partsSig = sig;
    setHidden(this.parts, ids.length === 0);
    this.parts.replaceChildren(
      ...ids.map((id) => {
        const p = byPart.get(id) ?? { part: id, have: 0, need: 0 };
        const done = p.have >= p.need && p.need > 0;
        const chip = el(
          "span",
          done ? "rr-raft__part is-done" : "rr-raft__part",
          el("span", "rr-raft__part-icon", PART_ICON[id]),
          el("b", "", `${Math.min(p.have, p.need)}/${p.need}`),
        );
        chip.title = t(`hud.part_${id}`);
        return chip;
      }),
    );
  }
}
