// Top-right raft card (§7, §17; Long Tide §8): seven segments (keel, deck, mast, sail, rudder, provisions, launch),
// the current stage's name and "n/7", its requirement rows ("🪵 1/2 · 🧵 3/4"), a day-lock badge ("Opens on day 3"),
// the assembly bar once every material is in ("Hold E to assemble (40%)", "Raising the mast needs 2 people"), the
// raft integrity bar once the keel exists, READY! once the launch window is open ("READY! Press E on it") and
// "3/5 aboard" while boarding. Under it: the status line (today's objective, the launch window, Captain Crab, the
// spring) and the heavy-load chip (green when escorted). A lost stage / hp shows up as a red shake. Owner: client-ui.

import type { RaftStage } from "../../../../shared/types";
import { itemName, t } from "../../i18n";
import { itemIcon } from "../content";
import { keyParams, keysSignature } from "../controls";
import { clamp01, el, replay, setHidden, setText, setVar, svg, toggleClass } from "../dom";
import { ICON_RAFT } from "../icons";
import type { HudModel, RaftHudModel } from "../models";

interface SegView {
  root: HTMLElement;
  fill: HTMLElement;
  frac: number;
}

export class RaftProgress {
  readonly el = el("div", "rr-raft");
  private readonly stageLabel = el("span", "rr-raft__stage");
  private readonly stageName = el("div", "rr-raft__name");
  private readonly segRow = el("div", "rr-raft__segs");
  private readonly segs: SegView[] = [];
  private readonly parts = el("div", "rr-raft__parts");
  private readonly lock = el("div", "rr-raft__lock");
  private readonly asm = el("div", "rr-raft__asm");
  private readonly asmFill = el("span", "rr-raft__fill");
  private readonly asmText = el("span", "rr-raft__asm-text");
  private readonly hp = el("div", "rr-raft__hp");
  private readonly hpFill = el("span", "rr-raft__fill");
  private readonly hpText = el("span", "rr-raft__hp-text");
  private readonly ready = el("div", "rr-raft__ready");
  private readonly readyText = el("span");
  private readonly aboard = el("div", "rr-raft__aboard");
  private readonly status = el("div", "rr-raft__status");
  private readonly heavy = el("div", "rr-raft__heavy");
  private stage: RaftStage | -1 = -1;
  private partsSig = "";
  private readySig = "";
  private asmSig = "";
  private statusSig = "";
  private heavySig = "";
  private lastHp = -1;

  constructor() {
    const head = el("div", "rr-raft__head", el("span", "rr-raft__icon", svg(ICON_RAFT)), el("span", "rr-raft__title", t("hud.raftTitle")), this.stageLabel);
    this.asm.append(el("span", "rr-raft__seg-track", this.asmFill), this.asmText);
    this.hp.append(el("span", "rr-raft__seg-track", this.hpFill), this.hpText);
    this.ready.append(this.readyText);
    for (const n of [this.ready, this.aboard, this.lock, this.asm, this.hp, this.status, this.heavy]) n.hidden = true;
    this.el.append(head, this.segRow, this.stageName, this.parts, this.lock, this.asm, this.hp, this.ready, this.aboard, this.status, this.heavy);
  }

  private buildSegs(n: number): void {
    if (this.segs.length === n) return;
    this.segs.length = 0;
    this.segRow.replaceChildren();
    for (let i = 0; i < n; i++) {
      const fill = el("span", "rr-raft__fill");
      const root = el("div", "rr-raft__seg", el("span", "rr-raft__seg-track", fill));
      root.title = t(`hud.raftStage_${i}`);
      this.segs.push({ root, fill, frac: -1 });
      this.segRow.append(root);
    }
    setVar(this.segRow, "--n", String(n));
  }

  update(raft: RaftHudModel): void {
    this.buildSegs(raft.stages);
    let have = 0;
    let need = 0;
    for (const p of raft.parts) {
      have += Math.min(p.have, p.need);
      need += p.need;
    }
    const cur = need > 0 ? clamp01(have / need) * 0.5 + Math.max(0, raft.assembly) * 0.5 : 0;
    this.segs.forEach((v, i) => {
      const frac = raft.stage > i ? 1 : raft.stage < i ? 0 : i === raft.stages - 1 ? (raft.ready ? 1 : 0) : cur;
      toggleClass(v.root, "is-current", raft.stage === i);
      toggleClass(v.root, "is-done", raft.stage > i);
      if (Math.abs(frac - v.frac) >= 0.002) {
        v.frac = frac;
        setVar(v.fill, "--v", `${(frac * 100).toFixed(1)}%`);
      }
    });

    if (raft.stage !== this.stage) {
      const back = this.stage !== -1 && raft.stage < this.stage;
      const forward = this.stage !== -1 && raft.stage > this.stage;
      this.stage = raft.stage;
      this.el.dataset.stage = String(raft.stage);
      setText(this.stageLabel, `${Math.min(raft.stage + 1, raft.stages)}/${raft.stages}`);
      setText(this.stageName, t(`hud.raftStage_${raft.stage}`));
      if (back) replay(this.el, "is-hurt");
      if (forward) replay(this.el, "is-stage-up");
    }
    // Lost hp (gnawing, puffers, Captain Crab) without a stage change.
    if (this.lastHp >= 0 && raft.hp >= 0 && raft.hp < this.lastHp - 1e-6) replay(this.el, "is-hurt");
    this.lastHp = raft.hp;

    this.renderParts(raft);
    setHidden(this.lock, raft.lockDay <= 0);
    if (raft.lockDay > 0) setText(this.lock, `🔒 ${t(raft.stage >= raft.stages - 1 ? "hud.launchLocked" : "hud.stageLocked", { day: raft.lockDay })}`);

    const asmSig = raft.assembly < 0 ? "-" : `${Math.round(raft.assembly * 100)}|${raft.minHolders}|${raft.holders}|${keysSignature()}`;
    if (asmSig !== this.asmSig) {
      this.asmSig = asmSig;
      setHidden(this.asm, raft.assembly < 0 || raft.lockDay > 0);
      if (raft.assembly >= 0) {
        setVar(this.asmFill, "--v", `${(raft.assembly * 100).toFixed(1)}%`);
        const pct = Math.round(raft.assembly * 100);
        const text = raft.minHolders > 1 && raft.holders < raft.minHolders ? t("hud.mastNeedsTwo") : t("hud.assemble", { ...keyParams(), pct });
        setText(this.asmText, text);
      }
    }

    setHidden(this.hp, raft.hp < 0);
    if (raft.hp >= 0) {
      setVar(this.hpFill, "--v", `${(raft.hp * 100).toFixed(1)}%`);
      setText(this.hpText, `${t("hud.raftHp")} ${Math.round(raft.hp * 100)}`);
      toggleClass(this.hp, "is-low", raft.hpLow);
    }

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

  /** The objective / launch window / boss / spring line and the heavy-load chip. */
  updateStatus(status: HudModel["status"], heavy: HudModel["heavy"]): void {
    const sig = `${status.objective}|${status.launchDay}|${status.launchOpen}|${status.boss}|${status.spring}`;
    if (sig !== this.statusSig) {
      this.statusSig = sig;
      const bits: string[] = [];
      if (status.objective) bits.push(`🎯 ${t(status.objective, keyParams())}`);
      if (status.boss === "tonight" || status.boss === "here") bits.push(`🦀 ${t("hud.bossTonight")}`);
      else if (status.boss === "returns") bits.push(`🦀 ${t("hud.bossReturns")}`);
      if (status.spring >= 0) bits.push(`💧 ${t("hud.springCharges", { n: status.spring })}`);
      setHidden(this.status, bits.length === 0);
      this.status.replaceChildren(...bits.map((b) => el("div", "rr-raft__status-line", b)));
    }
    const hsig = heavy ? `${heavy.escorted}` : "";
    if (hsig !== this.heavySig) {
      this.heavySig = hsig;
      setHidden(this.heavy, !heavy);
      if (heavy) setText(this.heavy, heavy.escorted ? `🤝 ${t("hud.escorted")}` : `🏋️ ${t("hud.heavy")}`);
      toggleClass(this.heavy, "is-escorted", !!heavy?.escorted);
    }
  }

  private renderParts(raft: RaftHudModel): void {
    const sig = raft.parts.map((p) => `${p.item}:${p.have}/${p.need}`).join("|");
    if (sig === this.partsSig) return;
    this.partsSig = sig;
    setHidden(this.parts, raft.parts.length === 0);
    this.parts.replaceChildren(
      ...raft.parts.map((p) => {
        const done = p.have >= p.need && p.need > 0;
        const chip = el(
          "span",
          done ? "rr-raft__part is-done" : "rr-raft__part",
          el("span", "rr-raft__part-icon", itemIcon(p.item)),
          el("b", "", `${Math.min(p.have, p.need)}/${p.need}`),
        );
        chip.title = itemName(p.item);
        return chip;
      }),
    );
  }
}
